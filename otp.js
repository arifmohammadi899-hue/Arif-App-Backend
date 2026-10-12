const crypto = require("crypto");
const nodemailer = require("nodemailer");

module.exports = function (app) {
  const codes = new Map();
  const requests = new Map();
  const ipRequests = new Map();

  app.post("/api/auth/request-email-otp", async (req, res) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const phone = String(req.body.phone || "").replace(/[\s()-]/g, "");
      const number = phone.replace(/^\+/, "");

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, message: "ایمیل معتبر وارد کنید" });
      }
      if (!/^\d{8,15}$/.test(number)) {
        return res.status(400).json({ success: false, message: "شماره تلفن بین‌المللی معتبر وارد کنید" });
      }
      if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
        return res.status(503).json({ success: false, message: "سرویس ایمیل هنوز تنظیم نشده است" });
      }

      const now = Date.now();
      const ip = req.ip || "unknown";
      const last = requests.get(email);
      if (last && now - last < 60000) {
        return res.status(429).json({ success: false, message: "برای ارسال دوباره یک دقیقه صبر کنید" });
      }

      const ipEntry = ipRequests.get(ip);
      if (ipEntry && now - ipEntry.time < 3600000 && ipEntry.count >= 10) {
        return res.status(429).json({ success: false, message: "تعداد درخواست‌ها بیش از حد مجاز است" });
      }

      requests.set(email, now);
      ipRequests.set(ip, {
        time: ipEntry && now - ipEntry.time < 3600000 ? ipEntry.time : now,
        count: ipEntry && now - ipEntry.time < 3600000 ? ipEntry.count + 1 : 1
      });

      const code = String(crypto.randomInt(100000, 1000000));
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_APP_PASSWORD
        }
      });

      await transporter.sendMail({
        from: `"ARIF APP" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "کد تأیید ARIF APP",
        text: `کد تأیید شما: ${code}\nاین کد تا ۵ دقیقه معتبر است. آن را در اختیار دیگران قرار ندهید.`,
        html: `<div dir="rtl" style="font-family:Arial,sans-serif"><h2>کد تأیید ARIF APP</h2><p>کد شما:</p><h1 style="letter-spacing:6px">${code}</h1><p>این کد تا ۵ دقیقه معتبر است. آن را در اختیار دیگران قرار ندهید.</p></div>`
      });

      codes.set(email, {
        hash: crypto.createHash("sha256").update(code).digest("hex"),
        phone: number,
        expires: now + 300000,
        tries: 0
      });

      return res.json({ success: true, message: "کد تأیید به ایمیل ارسال شد" });
    } catch (err) {
      console.error("EMAIL_OTP_ERROR:", String(err.message || err).slice(0, 200));
      return res.status(502).json({ success: false, message: "ارسال ایمیل تأیید ناموفق بود" });
    }
  });

  app.post("/api/auth/verify-email-otp", (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const phone = String(req.body.phone || "").replace(/[\s()-]/g, "").replace(/^\+/, "");
    const code = String(req.body.code || "");
    const entry = codes.get(email);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !/^\d{8,15}$/.test(phone) ||
        !entry || entry.phone !== phone ||
        entry.expires < Date.now() || entry.tries >= 5) {
      codes.delete(email);
      return res.status(400).json({ success: false, message: "کد نامعتبر یا منقضی شده است" });
    }

    entry.tries++;
    const supplied = crypto.createHash("sha256").update(code).digest();
    const expected = Buffer.from(entry.hash, "hex");

    if (!/^\d{6}$/.test(code) || !crypto.timingSafeEqual(supplied, expected)) {
      return res.status(400).json({ success: false, message: "کد تأیید اشتباه است" });
    }

    codes.delete(email);
    return res.json({ success: true, verified: true, message: "ایمیل تأیید شد" });
  });
};
