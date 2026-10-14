const crypto = require("crypto");


/* SESSION_TOKEN_HELPERS */
function createSession(email, secret) {
  const payload = Buffer.from(JSON.stringify({
    email,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret)
    .update(payload).digest('base64url');
  return payload + '.' + signature;
}
function readSession(token, secret) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const expected = crypto.createHmac('sha256', secret)
      .update(parts[0]).digest();
    const actual = Buffer.from(parts[1], 'base64url');
    if (actual.length !== expected.length ||
        !crypto.timingSafeEqual(actual, expected)) return null;
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (!data.email || !Number.isFinite(data.exp) ||
        data.exp <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch (_) {
    return null;
  }
}

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
      if (!process.env.RESEND_API_KEY) {
        return res.status(503).json({ success: false, message: "کلید سرویس ایمیل تنظیم نشده است" });
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
      const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + process.env.RESEND_API_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: "ARIF APP <onboarding@resend.dev>",
            to: [email],
            subject: "کد تأیید ARIF APP",
            text: `کد تأیید شما: ${code}\nاین کد تا ۵ دقیقه معتبر است. آن را در اختیار دیگران قرار ندهید.`,
            html: `<div dir="rtl" style="font-family:Arial,sans-serif"><h2>کد تأیید ARIF APP</h2><p>کد شما:</p><h1 style="letter-spacing:6px">${code}</h1><p>این کد تا ۵ دقیقه معتبر است. آن را در اختیار دیگران قرار ندهید.</p></div>`
          })
        });
        if (!response.ok) {
          const detail = await response.text();
          console.error("RESEND_EMAIL_ERROR:", response.status, detail.slice(0, 300));
          throw new Error("Resend API request failed: " + response.status);
        }

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

  app.post("/api/auth/verify-email-otp", async (req, res) => {
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

    const sessionSecret = process.env.ARIF_SESSION_SECRET;
    if (!sessionSecret || Buffer.byteLength(sessionSecret) < 32) {
      return res.status(503).json({ success: false, message: "تنظیمات نشست امن آماده نیست" });
    }
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return res.status(503).json({ success: false, message: "تنظیمات ثبت کاربران آماده نیست" });
    }
    try {
      const saved = await fetch(supabaseUrl.replace(/\/$/, "") + "/rest/v1/app_users?on_conflict=email", {
        method: "POST",
        headers: {
          "apikey": supabaseKey,
          "Authorization": "Bearer " + supabaseKey,
          "Content-Type": "application/json",
          "Prefer": "resolution=ignore-duplicates,return=minimal"
        },
        body: JSON.stringify({ email })
      });
      if (!saved.ok) {
        console.error("SUPABASE_USER_SAVE_ERROR:", saved.status);
        return res.status(503).json({ success: false, message: "ثبت حساب انجام نشد؛ دوباره تلاش کنید" });
      }
    } catch (err) {
      console.error("SUPABASE_USER_SAVE_ERROR:", String(err.message || err).slice(0, 150));
      return res.status(503).json({ success: false, message: "اتصال ثبت کاربران برقرار نشد؛ دوباره تلاش کنید" });
    }
    codes.delete(email);
    const sessionToken = createSession(email, sessionSecret);
    return res.json({
      success: true,
      verified: true,
      sessionToken,
      message: "ایمیل تأیید شد"
    });
  });

  app.get("/api/account/balance", async (req, res) => {
    const secret = process.env.ARIF_SESSION_SECRET;
    const auth = String(req.headers.authorization || "");
    const match = auth.match(/^Bearer (.+)$/i);
    if (!secret || !match) {
      return res.status(401).json({ success: false, message: "ورود معتبر لازم است" });
    }
    const session = readSession(match[1], secret);
    if (!session) {
      return res.status(401).json({ success: false, message: "نشست نامعتبر یا منقضی شده است" });
    }
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return res.status(503).json({ success: false, message: "تنظیمات پایگاه داده آماده نیست" });
    }
    try {
      const query = new URLSearchParams({
        select: "balance",
        email: "eq." + session.email,
        limit: "1"
      });
      const response = await fetch(url.replace(/\/$/, "") +
        "/rest/v1/app_users?" + query.toString(), {
          headers: {
            apikey: key,
            Authorization: "Bearer " + key
          }
        });
      if (!response.ok) {
        console.error("SUPABASE_BALANCE_ERROR:", response.status);
        return res.status(503).json({ success: false, message: "خواندن موجودی ناموفق بود" });
      }
      const rows = await response.json();
      if (!Array.isArray(rows) || !rows.length) {
        return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });
      }
      return res.json({ success: true, balance: Number(rows[0].balance) || 0 });
    } catch (err) {
      console.error("SUPABASE_BALANCE_ERROR:", String(err.message || err).slice(0, 150));
      return res.status(503).json({ success: false, message: "اتصال پایگاه داده برقرار نشد" });
    }
  });

};
