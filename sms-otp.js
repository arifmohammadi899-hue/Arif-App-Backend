const crypto = require("crypto");
const { smsVerified } = require("./auth-state");

module.exports = function (app) {
  const codes = new Map();
  const requests = new Map();
  const attempts = new Map();

  function normalizePhone(value) {
    return String(value || "").replace(/[\s()-]/g, "");
  }

  function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  app.post("/api/auth/request-sms-otp", async (req, res) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const phone = normalizePhone(req.body.phone);
      const number = phone.replace(/^\+/, "");

      if (!validEmail(email) || !/^\d{8,15}$/.test(number)) {
        return res.status(400).json({
          success: false,
          message: "ایمیل و شماره تلفن معتبر وارد کنید"
        });
      }

      if (!process.env.SMSPM_HASH ||
          !process.env.SMSPM_API_TOKEN ||
          !process.env.SMSPM_FROM_NUMBER) {
        return res.status(503).json({
          success: false,
          message: "تنظیمات سرویس پیامک کامل نیست"
        });
      }

      const now = Date.now();
      const key = email + "|" + number;
      const last = requests.get(key);

      if (last && now - last < 60000) {
        return res.status(429).json({
          success: false,
          message: "برای ارسال دوباره یک دقیقه صبر کنید"
        });
      }

      const ip = req.ip || "unknown";
      const ipEntry = requests.get("ip:" + ip);

      if (ipEntry && now - ipEntry.time < 3600000 &&
          ipEntry.count >= 10) {
        return res.status(429).json({
          success: false,
          message: "تعداد درخواست‌ها بیش از حد مجاز است"
        });
      }

      const code = String(crypto.randomInt(100000, 1000000));

      const response = await fetch("https://api.smspm.com", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          hash: process.env.SMSPM_HASH,
          token: process.env.SMSPM_API_TOKEN,
          toNumber: number,
          text: "ARIF APP verification code: " + code,
          fromNumber: process.env.SMSPM_FROM_NUMBER
        })
      });

      const raw = await response.text();
      let result;

      try {
        result = JSON.parse(raw);
      } catch {
        result = {};
      }

      const firstMessage =
        Array.isArray(result.messages) ? result.messages[0] : null;

      const messageId = firstMessage?.id || result.messageId || null;
      const accepted = response.ok && !result.error && !!messageId;

      console.log("SMSPM_RESULT:", JSON.stringify({
        httpStatus: response.status,
        accepted,
        providerStatus: firstMessage?.status || result.status || null,
        messageId
      }));

      if (!accepted) {
        console.error("SMSPM_ERROR:", response.status,
          String(result.error || "SMS request not accepted").slice(0, 200));

        return res.status(502).json({
          success: false,
          message: "ارسال پیامک تأیید نشد؛ تنظیمات سرویس را بررسی کنید"
        });
      }

      codes.set(key, {
        hash: crypto.createHash("sha256").update(code).digest("hex"),
        email,
        number,
        expires: now + 300000,
        tries: 0
      });

      requests.set(key, now);
      requests.set("ip:" + ip, {
        time: ipEntry && now - ipEntry.time < 3600000
          ? ipEntry.time : now,
        count: ipEntry && now - ipEntry.time < 3600000
          ? ipEntry.count + 1 : 1
      });

      return res.json({
        success: true,
        message: "کد پیامک ارسال شد"
      });
    } catch (err) {
      console.error("SMS_OTP_ERROR:", String(err.message || err).slice(0, 150));
      return res.status(502).json({
        success: false,
        message: "ارتباط با سرویس پیامک ناموفق بود"
      });
    }
  });

  app.post("/api/auth/verify-sms-otp", (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const phone = normalizePhone(req.body.phone);
    const number = phone.replace(/^\+/, "");
    const code = String(req.body.code || "");
    const key = email + "|" + number;
    const entry = codes.get(key);

    if (!validEmail(email) || !/^\d{8,15}$/.test(number) ||
        !entry || entry.expires < Date.now() || entry.tries >= 5) {
      codes.delete(key);
      return res.status(400).json({
        success: false,
        message: "کد پیامک نامعتبر یا منقضی شده است"
      });
    }

    entry.tries++;

    const supplied = crypto.createHash("sha256").update(code).digest();
    const expected = Buffer.from(entry.hash, "hex");

    if (!/^\d{6}$/.test(code) ||
        !crypto.timingSafeEqual(supplied, expected)) {
      return res.status(400).json({
        success: false,
        message: "کد پیامک اشتباه است"
      });
    }

    codes.delete(key);
    smsVerified.set(key, Date.now() + 10 * 60 * 1000);

    return res.json({
      success: true,
      verified: true,
      message: "شماره تلفن تأیید شد"
    });
  });
};
