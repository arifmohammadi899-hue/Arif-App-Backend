const crypto = require("crypto");
const { smsVerified } = require("./auth-state");

function normalizePhone(value) {
  return String(value || "").replace(/[\s()-]/g, "");
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function createSession(email, secret) {
  const payload = Buffer.from(JSON.stringify({
    email,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
  })).toString("base64url");

  const signature = crypto.createHmac("sha256", secret)
    .update(payload).digest("base64url");

  return payload + "." + signature;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return "scrypt:" + salt.toString("hex") + ":" + hash.toString("hex");
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || "").split(":");
    if (parts.length !== 3 || parts[0] !== "scrypt") return false;

    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    if (salt.length !== 16 || expected.length !== 64) return false;

    const actual = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

module.exports = function (app) {
  app.post("/api/auth/set-password", async (req, res) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const phone = normalizePhone(req.body.phone);
      const number = phone.replace(/^\+/, "");
      const password = String(req.body.password || "");
      let firstName = String(req.body.first_name || "").trim().slice(0, 100);
      let surname = String(req.body.surname || "").trim().slice(0, 100);
      let username = String(req.body.username || "").trim().slice(0, 50);
      let country = String(req.body.country || "").trim().slice(0, 100);
      let dialCode = String(req.body.dial_code || "").trim();

      if (!validEmail(email) || !/^\d{8,15}$/.test(number)) {
        return res.status(400).json({ success: false, message: "ایمیل یا شماره تلفن معتبر نیست" });
      }

      if (password.length < 8 || password.length > 128) {
        return res.status(400).json({ success: false, message: "گذرواژه باید حداقل ۸ نویسه باشد" });
      }

      const smsKey = email + "|" + number;
      const smsExpiry = smsVerified.get(smsKey);
      if (!smsExpiry || smsExpiry < Date.now()) {
        smsVerified.delete(smsKey);
        return res.status(403).json({ success: false, message: "ابتدا شماره تلفن را با پیامک تأیید کنید" });
      }

      const secret = process.env.ARIF_SESSION_SECRET;
      const base = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (!secret || Buffer.byteLength(secret) < 32 || !base || !key) {
        return res.status(503).json({ success: false, message: "تنظیمات امن سرور آماده نیست" });
      }

      const headers = {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json"
      };
      const root = base.replace(/\/$/, "") + "/rest/v1/app_users";

      const emailQuery = new URLSearchParams({
        select: "id,email,phone,email_verified,phone_verified,first_name,surname,username,country,dial_code",
        email: "eq." + email,
        limit: "1"
      });

      const emailResponse = await fetch(root + "?" + emailQuery, { headers });
      if (!emailResponse.ok) throw new Error("USER_LOOKUP_EMAIL_FAILED");
      const emailRows = await emailResponse.json();
      const existing = emailRows[0] || null;

      if (existing && existing.phone_verified !== true) {
        return res.status(403).json({
          success: false,
          message: "ابتدا ثبت‌نام و تأیید ایمیل و شماره تلفن را کامل کنید"
        });
      }

      if (existing) {
        firstName = firstName || existing.first_name || "";
        surname = surname || existing.surname || "";
        username = username || existing.username || "";
        country = country || existing.country || "";
        dialCode = dialCode || existing.dial_code || "";
      }

      if (!firstName || !surname || username.length < 3 || !country || !/^\+\d{1,4}$/.test(dialCode)) {
        return res.status(400).json({ success: false, message: "اطلاعات حساب کامل نیست" });
      }

      const phoneQuery = new URLSearchParams({
        select: "id,email,phone",
        phone: "eq.+" + number,
        limit: "1"
      });

      const phoneResponse = await fetch(root + "?" + phoneQuery, { headers });
      if (!phoneResponse.ok) throw new Error("USER_LOOKUP_PHONE_FAILED");
      const phoneRows = await phoneResponse.json();
      const phoneOwner = phoneRows[0] || null;

      if (phoneOwner && String(phoneOwner.email).toLowerCase() !== email) {
        return res.status(409).json({ success: false, message: "این شماره به حساب دیگری متصل است" });
      }

      if (existing && String(existing.phone || "").replace(/[\s()-]/g, "") !== "+" + number) {
        return res.status(409).json({
          success: false,
          message: "شماره تأییدشده با شماره ثبت‌شده این حساب مطابقت ندارد"
        });
      }

      const userData = {
        email,
        phone: "+" + number,
        first_name: firstName,
        surname,
        username,
        country,
        dial_code: dialCode,
        phone_verified: true,
        password_hash: hashPassword(password)
      };

      let saved;
      if (existing) {
        const updateQuery = new URLSearchParams({ id: "eq." + existing.id });
        saved = await fetch(root + "?" + updateQuery, {
          method: "PATCH",
          headers: { ...headers, Prefer: "return=minimal" },
          body: JSON.stringify(userData)
        });
      } else {
        saved = await fetch(root, {
          method: "POST",
          headers: { ...headers, Prefer: "return=minimal" },
          body: JSON.stringify({ ...userData, email_verified: false })
        });
      }

      if (!saved.ok) {
        const detail = await saved.text();
        console.error("SET_PASSWORD_SAVE_ERROR:", saved.status, detail.slice(0, 200));
        return res.status(503).json({ success: false, message: "ثبت گذرواژه انجام نشد" });
      }

      smsVerified.delete(smsKey);
      return res.json({
        success: true,
        sessionToken: createSession(email, secret),
        emailVerified: existing ? existing.email_verified === true : false,
        message: "گذرواژه ثبت شد"
      });
    } catch (err) {
      console.error("SET_PASSWORD_ERROR:", String(err.message || err).slice(0, 180));
      return res.status(503).json({ success: false, message: "ثبت گذرواژه ناموفق بود" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const identifier = String(
        req.body.identifier || req.body.email || req.body.phone || ""
      ).trim().toLowerCase();
      const password = String(req.body.password || "");
      const isEmail = validEmail(identifier);
      const phone = normalizePhone(identifier);
      const number = phone.replace(/^\+/, "");

      if ((!isEmail && !/^\d{8,15}$/.test(number)) ||
          !password || password.length > 128) {
        return res.status(400).json({
          success: false,
          message: "ایمیل یا شماره تلفن و گذرواژه معتبر نیست"
        });
      }

      const secret = process.env.ARIF_SESSION_SECRET;
      const base = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (!secret || Buffer.byteLength(secret) < 32 || !base || !key) {
        return res.status(503).json({
          success: false,
          message: "تنظیمات امن سرور آماده نیست"
        });
      }

      const filters = {
        select: "email,phone,email_verified,phone_verified,password_hash,first_name,surname,username,country,dial_code",
        limit: "1"
      };

      if (isEmail) {
        filters.email = "eq." + identifier;
      } else {
        filters.phone = "eq.+" + number;
      }

      const query = new URLSearchParams(filters);
      const response = await fetch(
        base.replace(/\/$/, "") + "/rest/v1/app_users?" + query,
        {
          headers: {
            apikey: key,
            Authorization: "Bearer " + key
          }
        }
      );

      if (!response.ok) throw new Error("LOGIN_LOOKUP_FAILED");

      const rows = await response.json();
      const user = rows[0];

      if (!user || user.phone_verified !== true || !user.password_hash ||
          !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({
          success: false,
          message: "ایمیل یا شماره تلفن و گذرواژه اشتباه است"
        });
      }

      return res.json({
        success: true,
        sessionToken: createSession(user.email, secret),
        profile: {
          email: user.email,
          phone: user.phone,
          firstName: user.first_name || "",
          surname: user.surname || "",
          name: [user.first_name, user.surname].filter(Boolean).join(" "),
          username: user.username || "",
          country: user.country || "",
          dialCode: user.dial_code || "",
          emailVerified: user.email_verified === true,
          phoneVerified: true
        },
        message: "ورود موفق بود"
      });
    } catch (err) {
      console.error("PASSWORD_LOGIN_ERROR:", String(err.message || err).slice(0, 160));
      return res.status(503).json({
        success: false,
        message: "ورود در حال حاضر انجام نشد"
      });
    }
  });

  const passwordResetCodes = new Map();
  const passwordResetRequests = new Map();

  app.post("/api/auth/request-password-reset", async (req, res) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      if (!validEmail(email)) {
        return res.status(400).json({ success: false, message: "ایمیل معتبر وارد کنید" });
      }

      const now = Date.now();
      const last = passwordResetRequests.get(email);
      if (last && now - last < 60000) {
        return res.status(429).json({ success: false, message: "برای ارسال دوباره یک دقیقه صبر کنید" });
      }
      passwordResetRequests.set(email, now);

      const base = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const apiKey = process.env.SENDLIBERTY_API_KEY;
      if (!base || !key || !apiKey) {
        return res.status(503).json({ success: false, message: "تنظیمات سرویس آماده نیست" });
      }

      const root = base.replace(/\/$/, "") + "/rest/v1/app_users";
      const query = new URLSearchParams({
        select: "id,email,email_verified",
        email: "eq." + email,
        limit: "1"
      });

      const lookup = await fetch(root + "?" + query, {
        headers: { apikey: key, Authorization: "Bearer " + key }
      });
      if (!lookup.ok) throw new Error("RESET_USER_LOOKUP_FAILED");

      const rows = await lookup.json();
      const user = rows[0];

      // پاسخ یکسان برای ایمیل‌های ناشناخته و حساب‌های تأییدنشده
      if (!user || user.email_verified !== true) {
        return res.json({ success: true, message: "اگر حساب تأییدشده‌ای با این ایمیل وجود داشته باشد، کد ارسال می‌شود" });
      }

      const code = String(crypto.randomInt(100000, 1000000));
      const sent = await fetch("https://sendliberty.com/api/send", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "ARIF APP <arifmohammadi899@gmail.com>",
          to: email,
          subject: "بازیابی گذرواژه ARIF APP",
          text: `کد بازیابی گذرواژه شما: ${code}\nاین کد تا ۵ دقیقه معتبر است.`,
          html: `<div dir="rtl" style="font-family:Arial,sans-serif"><h2>بازیابی گذرواژه ARIF APP</h2><h1>${code}</h1><p>این کد تا ۵ دقیقه معتبر است.</p></div>`
        })
      });

      if (!sent.ok) {
        const detail = await sent.text();
        console.error("PASSWORD_RESET_EMAIL_ERROR:", sent.status, detail.slice(0, 200));
        throw new Error("RESET_EMAIL_SEND_FAILED");
      }

      passwordResetCodes.set(email, {
        hash: crypto.createHash("sha256").update(code).digest("hex"),
        expires: now + 300000,
        tries: 0
      });

      return res.json({ success: true, message: "اگر حساب تأییدشده‌ای با این ایمیل وجود داشته باشد، کد ارسال می‌شود" });
    } catch (err) {
      console.error("PASSWORD_RESET_REQUEST_ERROR:", String(err.message || err).slice(0, 160));
      return res.status(503).json({ success: false, message: "ارسال کد بازیابی ناموفق بود" });
    }
  });

  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const code = String(req.body.code || "").trim();
      const password = String(req.body.password || "");

      if (!validEmail(email) || !/^\d{6}$/.test(code) || password.length < 8 || password.length > 128) {
        return res.status(400).json({ success: false, message: "ایمیل، کد یا گذرواژه جدید معتبر نیست" });
      }

      const entry = passwordResetCodes.get(email);
      if (!entry || entry.expires < Date.now() || entry.tries >= 5) {
        passwordResetCodes.delete(email);
        return res.status(400).json({ success: false, message: "کد بازیابی نامعتبر یا منقضی شده است" });
      }

      const actual = crypto.createHash("sha256").update(code).digest();
      const expected = Buffer.from(entry.hash, "hex");
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        entry.tries++;
        if (entry.tries >= 5) passwordResetCodes.delete(email);
        return res.status(400).json({ success: false, message: "کد بازیابی اشتباه است" });
      }

      const base = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!base || !key) {
        return res.status(503).json({ success: false, message: "تنظیمات امن سرور آماده نیست" });
      }

      const root = base.replace(/\/$/, "") + "/rest/v1/app_users";
      const query = new URLSearchParams({
        select: "id,email,email_verified",
        email: "eq." + email,
        limit: "1"
      });

      const lookup = await fetch(root + "?" + query, {
        headers: { apikey: key, Authorization: "Bearer " + key }
      });
      if (!lookup.ok) throw new Error("RESET_USER_LOOKUP_FAILED");

      const rows = await lookup.json();
      const user = rows[0];
      if (!user || user.email_verified !== true) {
        passwordResetCodes.delete(email);
        return res.status(400).json({ success: false, message: "حساب تأییدشده پیدا نشد" });
      }

      const saved = await fetch(root + "?" + new URLSearchParams({ id: "eq." + user.id }), {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({ password_hash: hashPassword(password) })
      });

      if (!saved.ok) throw new Error("RESET_PASSWORD_SAVE_FAILED");

      passwordResetCodes.delete(email);
      return res.json({ success: true, message: "گذرواژه جدید با موفقیت ثبت شد" });
    } catch (err) {
      console.error("PASSWORD_RESET_ERROR:", String(err.message || err).slice(0, 160));
      return res.status(503).json({ success: false, message: "تغییر گذرواژه ناموفق بود" });
    }
  });

};
