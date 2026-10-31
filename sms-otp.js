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


      if (!process.env.WILCYBERTEK_API_KEY &&
          !process.env.SEVEN_API_KEY &&
          (!process.env.TEXTBEE_API_KEY || !process.env.TEXTBEE_DEVICE_ID)) {
        return res.status(503).json({
          success: false,
          message: "سرویس پیامک تنظیم نشده است"
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


      let accepted = false;

      if (process.env.WILCYBERTEK_API_KEY) {
        const response = await fetch(
          "https://sms.wilcybertek.com/api",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json"
            },
            body: JSON.stringify({
              api_key: process.env.WILCYBERTEK_API_KEY,
              to: number,
              message: "ARIF APP verification code: " + code
            }),
            signal: AbortSignal.timeout(20000)
          }
        );

        const raw = await response.text();
        let result = {};
        try { result = JSON.parse(raw); } catch {}

        accepted = response.ok && result.status === "queued";

        console.log("WILCYBERTEK_SMS_RESULT:", JSON.stringify({
          httpStatus: response.status,
          status: result.status,
          accepted,
          message: result.message
        }));

        if (!accepted) {
          console.error("WILCYBERTEK_SMS_ERROR:", raw.slice(0, 300));
          return res.status(502).json({
            success: false,
            message: "ارسال پیامک از WilCybertek تأیید نشد"
          });
        }

      } else if (process.env.SEVEN_API_KEY) {
        const params = new URLSearchParams({
          to: "+" + number,
          text: "ARIF APP verification code: " + code
        });

        const response = await fetch(
          "https://gateway.seven.io/api/sms",
          {
            method: "POST",
            headers: {
              "X-Api-Key": process.env.SEVEN_API_KEY,
              "Accept": "application/json",
              "Content-Type": "application/x-www-form-urlencoded"
            },
            body: params.toString(),
            signal: AbortSignal.timeout(15000)
          }
        );

        const raw = await response.text();
        let result = {};
        try { result = JSON.parse(raw); } catch {}

        const messages = Array.isArray(result.messages)
          ? result.messages : [];

        accepted = response.ok &&
          String(result.success) === "100" &&
          (!messages.length || messages.some(m => m.success === true));

        console.log("SEVEN_SMS_RESULT:", JSON.stringify({
          httpStatus: response.status,
          success: result.success,
          accepted
        }));

        if (!accepted) {
          console.error("SEVEN_SMS_ERROR:", raw.slice(0, 300));
          return res.status(502).json({
            success: false,
            message: "ارسال پیامک از seven.io تأیید نشد"
          });
        }

      } else {
        const response = await fetch(
          "https://api.textbee.dev/api/v1/gateway/send-sms",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": process.env.TEXTBEE_API_KEY
            },
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify({
              deviceId: process.env.TEXTBEE_DEVICE_ID,
              recipients: ["+" + number],
              message: "ARIF APP verification code: " + code
            })
          }
        );

        const raw = await response.text();
        let result = {};
        try { result = JSON.parse(raw); } catch {}

        const data = result.data || {};
        const warning = data.warning || {};

        if (warning.code === "SMS_PERMISSION_MISSING") {
          return res.status(502).json({
            success: false,
            message: "مجوز پیامک TextBee مشکل دارد"
          });
        }

        accepted = response.ok && (
          data.success === true ||
          (typeof data.successCount === "number" &&
           data.successCount > 0)
        );

        console.log("TEXTBEE_SMS_RESULT:", JSON.stringify({
          httpStatus: response.status,
          success: data.success,
          successCount: data.successCount,
          accepted
        }));

        if (!accepted) {
          console.error("TEXTBEE_ERROR:", raw.slice(0, 300));
          return res.status(502).json({
            success: false,
            message: "ارسال پیامک تأیید نشد"
          });
        }
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
