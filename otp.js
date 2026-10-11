const crypto = require("crypto");

module.exports = function (app) {
  const codes = new Map();
  const requests = new Map();
  const attempts = new Map();

  app.post("/api/auth/request-otp", async (req, res) => {
    try {
      const phone = String(req.body.phone || "").replace(/[\s()-]/g, "");
      const number = phone.replace(/^\+/, "");

      if (!/^\d{8,15}$/.test(number)) {
        return res.status(400).json({
          success: false,
          message: "شماره تلفن بین‌المللی معتبر وارد کنید"
        });
      }

      if (!process.env.SMSPM_HASH ||
          !process.env.SMSPM_TOKEN ||
          !process.env.SMSPM_SENDER) {
        return res.status(503).json({
          success: false,
          message: "سرویس پیامک هنوز تنظیم نشده است"
        });
      }

      const now = Date.now();
      const ip = req.ip || "unknown";
      const last = requests.get(number);

      if (last && now - last < 60000) {
        return res.status(429).json({
          success: false,
          message: "برای ارسال دوباره یک دقیقه صبر کنید"
        });
      }

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
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          hash: process.env.SMSPM_HASH,
          token: process.env.SMSPM_TOKEN,
          toNumber: number,
          fromNumber: process.env.SMSPM_SENDER,
          text: "ARIF APP verification code: " + code
        })
      });

      const result = await response.json();

      if (!response.ok || result.error ||
          !Array.isArray(result.messages) ||
          !result.messages.length) {
        return res.status(502).json({
          success: false,
          message: "ارسال پیامک تأیید نشد"
        });
      }

      codes.set(number, {
        hash: crypto.createHash("sha256").update(code).digest("hex"),
        expires: now + 300000,
        tries: 0
      });

      requests.set(number, now);
      const entry = requests.get("ip:" + ip);
      requests.set("ip:" + ip, {
        time: entry && now - entry.time < 3600000 ? entry.time : now,
        count: entry && now - entry.time < 3600000
          ? entry.count + 1 : 1
      });

      return res.json({
        success: true,
        message: "درخواست ارسال کد ثبت شد"
      });
    } catch (_) {
      return res.status(502).json({
        success: false,
        message: "ارتباط با سرویس پیامک ناموفق بود"
      });
    }
  });

  app.post("/api/auth/verify-otp", (req, res) => {
    const phone = String(req.body.phone || "").replace(/[\s()-]/g, "");
    const number = phone.replace(/^\+/, "");
    const code = String(req.body.code || "");
    const entry = codes.get(number);

    if (!/^\d{8,15}$/.test(number) || !entry ||
        entry.expires < Date.now() || entry.tries >= 5) {
      codes.delete(number);
      return res.status(400).json({
        success: false,
        message: "کد نامعتبر یا منقضی شده است"
      });
    }

    entry.tries++;

    const supplied = crypto.createHash("sha256").update(code).digest();
    const expected = Buffer.from(entry.hash, "hex");

    if (!/^\d{6}$/.test(code) ||
        !crypto.timingSafeEqual(supplied, expected)) {
      return res.status(400).json({
        success: false,
        message: "کد تأیید اشتباه است"
      });
    }

    codes.delete(number);
    return res.json({
      success: true,
      verified: true,
      message: "شماره تلفن تأیید شد"
    });
  });
};
