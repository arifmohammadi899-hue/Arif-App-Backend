require("dotenv").config();
const express = require("express");

const app = express();
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === "null") {
    res.setHeader("Access-Control-Allow-Origin", "null");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
const adminAuth = require("./admin-auth");
app.use(express.json({ limit: "5mb" }));

const fs = require("fs");
const ORDERS_FILE = "./orders.json";
const orders = fs.existsSync(ORDERS_FILE) ? JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8")) : [];
let nextOrderId = orders.reduce((max, order) => Math.max(max, Number(order.id) || 1000), 1000) + 1;

app.get("/", (req, res) => {
  res.json({
    success: true,
    app: "Arif App",
    message: "Arif App Backend is running"
  });
});

app.get("/api/prices", (req, res) => {
  const prices = require("./prices.json");
  res.json({
    success: true,
    prices
  });
});

app.post("/api/prices", (req, res) => {
  const auth = req.headers.authorization || "";
  const adminUser = process.env.ADMIN_USER;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminUser || !adminPassword || adminPassword === "change-me") {
    return res.status(503).json({
      success: false,
      message: "تنظیمات مدیر آماده نیست"
    });
  }

  const expected = "Basic " + Buffer.from(
    adminUser + ":" + adminPassword
  ).toString("base64");

  if (auth !== expected) {
    return res.status(401).json({
      success: false,
      message: "دسترسی غیرمجاز"
    });
  }

  const prices = req.body;

  if (!prices || typeof prices !== "object" || Array.isArray(prices)) {
    return res.status(400).json({
      success: false,
      message: "قیمت‌ها نامعتبر است"
    });
  }

  require("fs").writeFileSync(
    "./prices.json",
    JSON.stringify(prices, null, 2),
    "utf8"
  );

  res.json({
    success: true,
    message: "قیمت‌ها با موفقیت ذخیره شد",
    prices
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "ok"
  });
});

app.post("/api/orders", (req, res) => {
  const {
    product,
    price,
    playerId,
    tracking
  } = req.body;

  if (!product || !price || !playerId || !tracking) {
    return res.status(400).json({
      success: false,
      message: "اطلاعات سفارش کامل نیست"
    });
  }

  const order = {
    id: nextOrderId++,
    product: String(product),
    price: String(price),
    playerId: String(playerId),
    tracking: String(tracking),
    status: "pending",
    createdAt: new Date().toISOString()
  };

  orders.push(order);
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), "utf8");

  res.status(201).json({
    success: true,
    message: "سفارش با موفقیت ثبت شد",
    order
  });
});

app.get("/api/orders", (req, res) => {
  res.json({
    success: true,
    count: orders.length,
    orders
  });
});



app.get("/api/afgtopup/data-bundles", async (req, res) => {
  try {
    const phone = String(req.query.phone || "").trim();

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "شماره موبایل وارد نشده است"
      });
    }

    const apiKey = process.env.AFGTOPUP_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message: "AFGTOPUP_API_KEY تنظیم نشده است"
      });
    }

    const url = new URL(
      "https://afgtopup.com/.netlify/functions/partner-data-bundles"
    );
    url.searchParams.set("phone", phone);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    const settings = JSON.parse(fs.readFileSync("./afgtopup-settings.json", "utf8"));
    const eurRate = Number(settings.eur_to_toman) || 0;
    const margin = Number(settings.margin_percent) || 0;
    if (Array.isArray(data.bundles)) data.bundles = data.bundles.map(x => ({...x, cost_toman: Math.round(Number(x.eur_cost || 0) * eurRate), retail_price_toman: Math.round(Number(x.eur_cost || 0) * eurRate * (1 + margin / 100))}));
    res.json(data);
  } catch (error) {
    console.error("AFGTopup data bundles error:", error);
    res.status(500).json({
      success: false,
      message: "خطا در اتصال به AFGTopup"
    });
  }
});


app.post("/api/afgtopup/data-bundle-topup", async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").trim();
    const bundleId = String(req.body?.bundle_id || "").trim();
    const externalId = String(req.body?.external_id || "").trim();

    if (!phone || !bundleId || !externalId) {
      return res.status(400).json({
        success: false,
        message: "phone، bundle_id و external_id الزامی هستند"
      });
    }

    const apiKey = process.env.AFGTOPUP_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message: "AFGTOPUP_API_KEY تنظیم نشده است"
      });
    }

    const { execFile } = await import("child_process");

    const payload = JSON.stringify({
      phone,
      bundle_id: bundleId,
      external_id: externalId
    });

    execFile(
      "curl",
      [
        "--http1.1",
        "-sS",
        "--max-time", "30",
        "-X", "POST",
        "https://afgtopup.com/.netlify/functions/partner-data-bundle-topup",
        "-H", "Content-Type: application/json",
        "-H", "X-API-Key: " + apiKey,
        "-d", payload
      ],
      (error, stdout, stderr) => {
        if (error) {
          console.error("AFGTopup curl error:", stderr || error);
          return res.status(502).json({
            success: false,
            message: "خطا در اتصال به AFGTopup"
          });
        }

        try {
          const data = JSON.parse(stdout);
          res.json(data);
        } catch (parseError) {
          console.error("AFGTopup invalid JSON:", stdout);
          res.status(502).json({
            success: false,
            message: "پاسخ نامعتبر از AFGTopup"
          });
        }
      }
    );
  } catch (error) {
    console.error("AFGTopup data bundle topup error:", error);
    res.status(500).json({
      success: false,
      message: "خطا در اتصال به AFGTopup"
    });
  }
});
app.patch("/api/orders/:id/status", (req, res) => {
  const auth = req.headers.authorization || "";
  const adminUser = process.env.ADMIN_USER;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminUser || !adminPassword || adminPassword === "change-me") {
    return res.status(503).json({ success: false, message: "تنظیمات مدیر آماده نیست" });
  }
  const expected = "Basic " + Buffer.from(
    adminUser + ":" + adminPassword
  ).toString("base64");

  if (auth !== expected) {
    return res.status(401).json({
      success: false,
      message: "دسترسی غیرمجاز"
    });
  }

  const id = Number(req.params.id);
  const status = String(req.body.status || "").trim();

  const allowed = ["pending", "completed", "cancelled"];

  if (!allowed.includes(status)) {
    return res.status(400).json({
      success: false,
      message: "وضعیت نامعتبر است"
    });
  }

  const order = orders.find(order => Number(order.id) === id);

  if (!order) {
    return res.status(404).json({
      success: false,
      message: "سفارش پیدا نشد"
    });
  }

  order.status = status;
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), "utf8");

  res.json({
    success: true,
    message: "وضعیت سفارش تغییر کرد",
    order
  });
});

app.delete("/api/orders/:id", (req, res) => {
  const auth = req.headers.authorization || "";
  const adminUser = process.env.ADMIN_USER;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminUser || !adminPassword || adminPassword === "change-me") {
    return res.status(503).json({ success: false, message: "تنظیمات مدیر آماده نیست" });
  }
  const expected = "Basic " + Buffer.from(
    adminUser + ":" + adminPassword
  ).toString("base64");

  if (auth !== expected) {
    res.set("WWW-Authenticate", "Basic realm=\"Arif App Admin\"");
    return res.status(401).json({
      success: false,
      message: "دسترسی غیرمجاز"
    });
  }

  const id = Number(req.params.id);
  const index = orders.findIndex(order => Number(order.id) === id);

  if (index === -1) {
    return res.status(404).json({
      success: false,
      message: "سفارش پیدا نشد"
    });
  }

  const deleted = orders.splice(index, 1)[0];
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), "utf8");

  res.json({
    success: true,
    message: "سفارش حذف شد",
    order: deleted
  });
});



app.get("/admin/login", (req, res) => {
  res.set("Cache-Control", "no-store");
  if (adminAuth.isAdmin(req)) return res.redirect("/admin");
  res.type("html").send(`<!doctype html>
<html lang="fa" dir="rtl"><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ورود مدیر ARIF APP</title>
<style>
body{font-family:Arial,sans-serif;max-width:380px;margin:50px auto;padding:20px}
input,button{box-sizing:border-box;width:100%;padding:12px;margin:8px 0}
</style>
<h2>ورود مدیر ARIF APP</h2>
<form id="f">
<input name="username" autocomplete="username" placeholder="نام کاربری مدیر" required>
<input name="password" type="password" autocomplete="current-password" placeholder="رمز مدیر" required>
<button>ورود</button><p id="msg" role="alert"></p>
</form>
<script>
f.addEventListener("submit",async e=>{
 e.preventDefault();
 const msg=document.getElementById("msg");
 msg.textContent="در حال بررسی...";
 try{
  const r=await fetch("/admin/login",{method:"POST",credentials:"same-origin",
   headers:{"Content-Type":"application/json"},
   body:JSON.stringify({username:f.username.value,password:f.password.value})});
  const d=await r.json();
  if(!r.ok||!d.success)throw Error(d.message||"ورود ناموفق بود");
  location.replace("/admin");
 }catch(err){msg.textContent=err.message||"ارتباط برقرار نشد";}
});
</script></html>`);
});

app.post("/admin/login", (req, res) => {
  const expectedUser = process.env.ADMIN_USER || "";
  const expectedPass = process.env.ADMIN_PASSWORD || "";
  if (!expectedUser || !expectedPass || expectedPass === "change-me") {
    return res.status(503).json({success:false,message:"تنظیمات مدیر آماده نیست"});
  }
  const same = (a,b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && require("crypto").timingSafeEqual(x,y);
  };
  if (!same(req.body?.username || "", expectedUser) ||
      !same(req.body?.password || "", expectedPass)) {
    return res.status(401).json({success:false,message:"نام کاربری یا رمز نادرست است"});
  }
  try {
    adminAuth.setSessionCookie(res, adminAuth.createSession(expectedUser));
    return res.json({success:true});
  } catch (e) {
    console.error("ADMIN_SESSION_CONFIG_ERROR:", String(e.message || e).slice(0,100));
    return res.status(503).json({success:false,message:"تنظیم نشست مدیر در سرور کامل نیست"});
  }
});

app.post("/admin/logout", (req, res) => {
  adminAuth.clearSessionCookie(res);
  res.redirect(303, "/admin/login");
});

app.post("/admin/users/balance", async (req, res) => {
  if (!adminAuth.isAdmin(req)) return res.status(401).json({success:false,message:"نشست مدیر منقضی شده؛ دوباره وارد شوید"});
  const email = String(req.body?.email || "").trim().toLowerCase();
  const amount = Number(req.body?.amount);
  const operation = String(req.body?.operation || "");

  if (!email || !Number.isSafeInteger(amount) || amount < 1 || amount > 100000000 ||
      !["add", "subtract"].includes(operation)) {
    return res.status(400).json({ success: false, message: "ایمیل، مبلغ یا عملیات نامعتبر است" });
  }

  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return res.status(503).json({ success: false, message: "تنظیمات پایگاه داده کامل نیست" });
    }

    const response = await fetch(
      url.replace(/\/$/, "") + "/rest/v1/rpc/admin_adjust_user_balance",
      {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          p_email: email,
          p_amount: amount,
          p_operation: operation
        })
      }
    );

    const resultText = await response.text();
    if (!response.ok) {
      let message = "تغییر موجودی ناموفق بود";
      if (resultText.includes("user_not_found")) message = "کاربر پیدا نشد";
      else if (resultText.includes("insufficient_balance")) message = "موجودی برای کاهش کافی نیست";
      else if (resultText.includes("invalid_amount")) message = "مبلغ نامعتبر است";
      return res.status(response.status === 404 ? 404 : 400).json({ success: false, message });
    }

    let balance;
    try { balance = JSON.parse(resultText); } catch (_) { balance = Number(resultText); }
    return res.json({ success: true, balance, message: "موجودی با موفقیت تغییر کرد" });
  } catch (_) {
    return res.status(500).json({ success: false, message: "ارتباط با پایگاه داده برقرار نشد" });
  }
});

app.get("/admin", async (req, res) => {
  if (!adminAuth.isAdmin(req)) return res.redirect(303, "/admin/login");
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);

  let appUsers = [];
  let usersLoadError = "";
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      usersLoadError = "تنظیمات پایگاه داده کامل نیست";
    } else {
      const response = await fetch(
        supabaseUrl.replace(/\/$/, "") +
          "/rest/v1/app_users?select=email,balance,created_at&order=created_at.desc&limit=500",
        { headers: { apikey: supabaseKey, Authorization: "Bearer " + supabaseKey } }
      );
      if (!response.ok) {
        usersLoadError = "خواندن فهرست کاربران ناموفق بود";
      } else {
        appUsers = await response.json();
      }
    }
  } catch (_) {
    usersLoadError = "اتصال به پایگاه داده برقرار نشد";
  }

  const userRows = appUsers.map(user => `
    <tr>
      <td>${escapeHtml(user.email)}</td>
      <td class="user-balance">${escapeHtml(Number(user.balance || 0).toLocaleString("fa-IR"))} تومان</td>
      <td>${escapeHtml(user.created_at || "")}</td>
      <td>
        <form class="balance-form" data-email="${escapeHtml(user.email)}">
          <input name="amount" type="number" min="1" max="100000000" step="1" required placeholder="مبلغ به تومان" style="width:120px">
          <select name="operation">
            <option value="add">افزایش</option>
            <option value="subtract">کاهش</option>
          </select>
          <button type="submit">ثبت</button>
          <small class="balance-result" aria-live="polite"></small>
        </form>
      </td>
    </tr>
  `).join("");

  const rows = orders.map(order => `
    <tr>
      <td>${escapeHtml(order.id)}</td>
      <td>${escapeHtml(order.product)}</td>
      <td>${escapeHtml(order.price)}</td>
      <td>${escapeHtml(order.playerId)}</td>
      <td>${escapeHtml(order.tracking)}</td>
      <td>${escapeHtml(order.status)}</td>
      <td>${escapeHtml(order.createdAt)}</td>
    </tr>
  `).join("");


  let walletDeposits = [];
  let walletLoadError = "";
  try {
    const u = process.env.SUPABASE_URL;
    const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!u || !k) {
      walletLoadError = "تنظیمات پایگاه داده کامل نیست";
    } else {
      const r = await fetch(u.replace(/\/$/, "") +
        "/rest/v1/wallet_deposits?select=id,user_id,amount,payment_reference,receipt_path,status,created_at,reviewed_at&order=created_at.desc&limit=200",
        { headers: { apikey: k, Authorization: "Bearer " + k } });
      if (!r.ok) walletLoadError = "خواندن درخواست‌های شارژ ناموفق بود";
      else walletDeposits = await r.json();
    }
  } catch (_) {
    walletLoadError = "اتصال به پایگاه داده برقرار نشد";
  }
  const walletRows = walletDeposits.map(d => `
    <tr>
      <td>${escapeHtml(d.id)}</td>
      <td>${escapeHtml(d.user_id)}</td>
      <td>${escapeHtml(Number(d.amount || 0).toLocaleString("fa-IR"))} تومان</td>
      <td>${escapeHtml(d.payment_reference || "ثبت نشده")}</td>
      <td class="wallet-status">${escapeHtml(d.status)}</td>
      <td>${escapeHtml(d.created_at || "")}</td>
      <td>
        ${d.receipt_path ? `
          <button class="wallet-receipt" data-id="${escapeHtml(d.id)}">مشاهده رسید</button>
        ` : "رسید ثبت نشده"}
        <small class="wallet-receipt-result" aria-live="polite"></small>
        ${d.status === "pending" ? `
          <button class="wallet-review" data-id="${escapeHtml(d.id)}" data-status="approved">تأیید شارژ</button>
          <button class="wallet-review" data-id="${escapeHtml(d.id)}" data-status="rejected">رد شارژ</button>
        ` : "بررسی شده"}
        <small class="wallet-result" aria-live="polite"></small>
      </td>
    </tr>
  `).join("");

  res.send(`<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>پنل مدیریت Arif App</title>
<style>
body{font-family:Arial,sans-serif;background:#f5f5f5;padding:20px}
h1{text-align:center}
table{width:100%;border-collapse:collapse;background:white}
th,td{border:1px solid #ddd;padding:10px;text-align:center}
th{background:#222;color:white}
input,select,button{padding:7px;margin:3px}
button{cursor:pointer}
.balance-result{display:block}
</style>
</head>
<body>
<h1>پنل مدیریت Arif App</h1>
<h2>کاربران و موجودی حساب</h2>
<p>تعداد کاربران ثبت‌شده: ${appUsers.length}</p>
${usersLoadError ? `<p>${escapeHtml(usersLoadError)}</p>` : ""}
<table>
<tr><th>ایمیل کاربر</th><th>موجودی حساب</th><th>تاریخ ثبت‌نام</th><th>مدیریت موجودی</th></tr>
${userRows}
</table>

<h2>درخواست‌های شارژ کیف پول</h2>
<p>تعداد درخواست‌ها: ${walletDeposits.length}</p>
${walletLoadError ? `<p>${escapeHtml(walletLoadError)}</p>` : ""}
<table>
<tr><th>شماره درخواست</th><th>شناسه کاربر</th><th>مبلغ</th><th>شماره پیگیری پرداخت</th><th>وضعیت</th><th>تاریخ</th><th>عملیات</th></tr>
${walletRows}
</table>

<h2>سفارش‌ها</h2>
<p>تعداد سفارش‌ها: ${orders.length}</p>
<table>
<tr><th>شماره</th><th>محصول</th><th>قیمت</th><th>Player ID</th><th>پیگیری</th><th>وضعیت</th><th>تاریخ</th></tr>
${rows}
</table>
<script>

document.querySelectorAll(".wallet-review").forEach(button => {
  button.addEventListener("click", async () => {
    const row = button.closest("tr");
    const result = row.querySelector(".wallet-result");
    const statusCell = row.querySelector(".wallet-status");
    const buttons = row.querySelectorAll(".wallet-review");
    if (button.dataset.status === "approved" &&
        !confirm("آیا از تأیید این شارژ و افزایش موجودی مطمئن هستید؟")) return;
    if (button.dataset.status === "rejected" &&
        !confirm("آیا درخواست شارژ رد شود؟")) return;
    buttons.forEach(b => b.disabled = true);
    result.textContent = "در حال بررسی...";
    try {
      const response = await fetch("/api/admin/wallet-deposits/" +
        encodeURIComponent(button.dataset.id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ status: button.dataset.status })
        });
      const body = await response.json();
      if (!response.ok || !body.success)
        throw new Error(body.message || "بررسی درخواست ناموفق بود");
      statusCell.textContent = button.dataset.status;
      result.textContent = button.dataset.status === "approved"
        ? "تأیید شد و موجودی افزایش یافت" : "درخواست رد شد";
      buttons.forEach(b => b.remove());
    } catch (error) {
      result.textContent = error.message || "ارتباط برقرار نشد";
      buttons.forEach(b => b.disabled = false);
    }
  });
});


document.querySelectorAll(".wallet-receipt").forEach(button => {
  button.addEventListener("click", async () => {
    const row = button.closest("tr");
    const result = row.querySelector(".wallet-receipt-result");
    const originalText = button.textContent;
    const preview = window.open("about:blank", "_blank");

    if (preview) {
      preview.document.write("<p dir='rtl'>در حال دریافت رسید امن...</p>");
    }

    button.disabled = true;
    result.textContent = "در حال دریافت رسید...";
    try {
      const response = await fetch(
        "/api/admin/wallet-deposits/" +
        encodeURIComponent(button.dataset.id) + "/receipt",
        { method: "GET", credentials: "same-origin" }
      );

      const body = await response.json();
      if (!response.ok || !body.success || !body.url) {
        throw new Error(body.message || "دریافت رسید ناموفق بود");
      }

      if (preview) {
        preview.location.replace(body.url);
      } else {
        window.location.assign(body.url);
      }
      result.textContent = "رسید آماده مشاهده است؛ لینک موقت ۵ دقیقه اعتبار دارد.";
    } catch (error) {
      if (preview) preview.close();
      result.textContent = error.message || "ارتباط برقرار نشد";
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });
});

document.querySelectorAll(".balance-form").forEach(form => {
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const result = form.querySelector(".balance-result");
    const button = form.querySelector('button[type="submit"]');
    const data = new FormData(form);
    button.disabled = true;
    result.textContent = "در حال ثبت...";
    try {
      const response = await fetch("/admin/users/balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          email: form.dataset.email,
          amount: Number(data.get("amount")),
          operation: data.get("operation")
        })
      });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.message || "خطا در ثبت");
      form.closest("tr").querySelector(".user-balance").textContent =
        Number(body.balance).toLocaleString("fa-IR") + " تومان";
      result.textContent = body.message;
      form.querySelector('[name="amount"]').value = "";
    } catch (error) {
      result.textContent = error.message || "ارتباط برقرار نشد";
    } finally {
      button.disabled = false;
    }
  });
});
</script>
</body>
</html>`);
});


/* MARKETPLACE_API_V1 */
const marketCrypto = require("crypto");

function marketSession(req) {
  const secret = process.env.ARIF_SESSION_SECRET;
  const match = String(req.headers.authorization || "").match(/^Bearer (.+)$/i);
  if (!secret || !match) return null;

  try {
    const parts = match[1].split(".");
    if (parts.length !== 2) return null;

    const expected = marketCrypto.createHmac("sha256", secret)
      .update(parts[0]).digest();
    const actual = Buffer.from(parts[1], "base64url");

    if (actual.length !== expected.length ||
        !marketCrypto.timingSafeEqual(actual, expected)) return null;

    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    if (!payload.email || !Number.isFinite(payload.exp) ||
        payload.exp <= Math.floor(Date.now() / 1000)) return null;

    return { email: String(payload.email).trim().toLowerCase() };
  } catch (_) {
    return null;
  }
}

function marketConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("database_not_configured");
  return { base: url.replace(/\/$/, ""), key };
}

async function marketUser(email) {
  const { base, key } = marketConfig();
  const q = new URLSearchParams({
    select: "id,email",
    email: "eq." + email,
    limit: "1"
  });
  const r = await fetch(base + "/rest/v1/app_users?" + q, {
    headers: { apikey: key, Authorization: "Bearer " + key }
  });
  if (!r.ok) throw new Error("user_lookup_failed");
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

app.get("/api/marketplace/ads", async (req, res) => {
  try {
    const { base, key } = marketConfig();
    const q = new URLSearchParams({
      select: "id,user_id,category,title,price,description,phone,photos,video_url,seller,created_at",
      order: "created_at.desc",
      limit: "100"
    });
    if (req.query.category && String(req.query.category) !== "همه") {
      q.set("category", "eq." + String(req.query.category).slice(0, 80));
    }
    const r = await fetch(base + "/rest/v1/marketplace_ads?" + q, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!r.ok) {
      console.error("MARKETPLACE_LIST_ERROR:", r.status, (await r.text()).slice(0, 200));
      return res.status(503).json({ success: false, message: "خواندن آگهی‌ها ناموفق بود" });
    }
    return res.json({ success: true, ads: await r.json() });
  } catch (e) {
    console.error("MARKETPLACE_LIST_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "اتصال بازار آنلاین برقرار نشد" });
  }
});

app.post("/api/marketplace/ads", async (req, res) => {
  const session = marketSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "برای ثبت آگهی ابتدا وارد حساب شوید" });
  }

  const category = String(req.body.category || "").trim().slice(0, 80);
  const title = String(req.body.title || "").trim();
  const price = Number(req.body.price);
  const description = String(req.body.description || "").trim().slice(0, 5000);
  const phone = String(req.body.phone || "").trim().slice(0, 25);

  if (!category || !title || title.length > 120 ||
      !Number.isSafeInteger(price) || price < 0 || price > 9000000000000000) {
    return res.status(400).json({ success: false, message: "دسته‌بندی، عنوان یا قیمت معتبر نیست" });
  }

  // رسانه‌ها باید در Storage آپلود شوند؛ دریافت Data URL در این مسیر مجاز نیست.
  const photos = Array.isArray(req.body.photos) ? req.body.photos : [];
  if (photos.length || req.body.video || req.body.video_url) {
    return res.status(400).json({
      success: false,
      message: "آپلود آنلاین عکس و ویدیو هنوز فعال نشده است؛ فعلاً آگهی متنی ثبت کنید"
    });
  }

  try {
    const { base, key } = marketConfig();
    const user = await marketUser(session.email);
    if (!user) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const r = await fetch(base + "/rest/v1/marketplace_ads", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        user_id: user.id,
        category,
        title,
        price,
        description,
        phone,
        photos: [],
        video_url: "",
        seller: session.email
      })
    });

    if (!r.ok) {
      console.error("MARKETPLACE_CREATE_ERROR:", r.status, (await r.text()).slice(0, 200));
      return res.status(503).json({ success: false, message: "ثبت آگهی ناموفق بود" });
    }
    const rows = await r.json();
    return res.status(201).json({ success: true, ad: rows[0] });
  } catch (e) {
    console.error("MARKETPLACE_CREATE_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "اتصال بازار آنلاین برقرار نشد" });
  }
});

app.delete("/api/marketplace/ads/:id", async (req, res) => {
  const session = marketSession(req);
  if (!session) return res.status(401).json({ success: false, message: "ورود معتبر لازم است" });

  const id = String(req.params.id || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ success: false, message: "شناسه آگهی معتبر نیست" });
  }

  try {
    const { base, key } = marketConfig();
    const user = await marketUser(session.email);
    if (!user) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const q = new URLSearchParams({ id: "eq." + id, user_id: "eq." + user.id });
    const r = await fetch(base + "/rest/v1/marketplace_ads?" + q, {
      method: "DELETE",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        Prefer: "return=representation"
      }
    });
    if (!r.ok) {
      console.error("MARKETPLACE_DELETE_ERROR:", r.status);
      return res.status(503).json({ success: false, message: "حذف آگهی ناموفق بود" });
    }
    const rows = await r.json();
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "آگهی پیدا نشد یا متعلق به شما نیست" });
    }
    return res.json({ success: true });
  } catch (e) {
    console.error("MARKETPLACE_DELETE_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "اتصال بازار آنلاین برقرار نشد" });
  }
});
/* END MARKETPLACE_API_V1 */


require("./otp")(app);
// SMS OTP disabled

app.get("/api/app-version", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    success: true,
    versionCode: Number(process.env.APP_VERSION_CODE || 5),
    versionName: process.env.APP_VERSION_NAME || "1.4",
    downloadUrl: process.env.APP_APK_URL || "https://github.com/arifmohammadi899-hue/ArifApp2026/releases/download/v1.4/ARIF-APP.apk",
    forceUpdate: process.env.APP_FORCE_UPDATE === "true",
    releaseNotes: process.env.APP_RELEASE_NOTES || "نسخه 1.4: افزودن سیستم بررسی خودکار نسخه جدید و بهبود برنامه."
  });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Arif App Backend running on port ${PORT}`);
});
