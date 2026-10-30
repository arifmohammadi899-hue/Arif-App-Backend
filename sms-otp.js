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

      if (!process.env.SEMYSMS_TOKEN ||
          !process.env.SEMYSMS_DEVICE_ID) {
        return res.status(503).json({
          success: false,
          message: "سرویس SemySMS هنوز تنظیم نشده است"
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

      const params = new URLSearchParams({
        token: process.env.SEMYSMS_TOKEN,
        device: process.env.SEMYSMS_DEVICE_ID,
        phone: "+" + number,
        msg: "ARIF APP verification code: " + code
      });

      const response = await fetch(
        "https://semysms.net/api/3/sms.php",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: params.toString(),
          signal: AbortSignal.timeout(20000)
        }
      );

      const raw = await response.text();
      let result;
      try {
        result = JSON.parse(raw);
      } catch {
        result = {};
      }

      const accepted =
        result.code === 0 || result.code === "0";

      console.log("SEMYSMS_RESULT:", JSON.stringify({
        httpStatus: response.status,
        code: result.code ?? null,
        smsId: result.id ?? null,
        success: response.ok && accepted
      }));

      if (!response.ok || !accepted) {
        console.error("SEMYSMS_ERROR:",
          response.status, raw.slice(0, 300));
        return res.status(502).json({
          success: false,
          message: "ارسال پیامک تأیید نشد"
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
