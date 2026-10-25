require("dotenv").config();
const express = require("express");

const app = express();
app.set("trust proxy", 1);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === "null") {
    res.setHeader("Access-Control-Allow-Origin", "null");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
const adminAuth = require("./admin-auth");
app.use(express.json({ limit: "35mb" }));

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


function orderFromDb(row) {
  return {
    id: row.id,
    product: row.product,
    price: row.price,
    playerId: row.player_id,
    tracking: row.tracking,
    status: row.status,
    createdAt: row.created_at
  };
}

async function orderDbRequest(path, options = {}) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error("database_not_configured");

  const response = await fetch(
    base.replace(/\/$/, "") + "/rest/v1/" + path,
    {
      ...options,
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const body = await response.text();
  let data = [];
  if (body) {
    try { data = JSON.parse(body); }
    catch (_) { throw new Error("database_invalid_response"); }
  }

  if (!response.ok) {
    console.error("ORDER_DATABASE_ERROR:", response.status, body.slice(0, 300));
    throw new Error("database_request_failed");
  }
  return data;
}

app.post("/api/orders", async (req, res) => {
  const { product, price, playerId, tracking } = req.body || {};

  if (!product || !price || !playerId || !tracking) {
    return res.status(400).json({
      success: false,
      message: "اطلاعات سفارش کامل نیست"
    });
  }

  try {
    const rows = await orderDbRequest("app_orders", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        product: String(product),
        price: String(price),
        player_id: String(playerId),
        tracking: String(tracking),
        status: "pending"
      })
    });

    if (!Array.isArray(rows) || !rows.length) {
      throw new Error("database_empty_result");
    }

    return res.status(201).json({
      success: true,
      message: "سفارش با موفقیت ثبت شد",
      order: orderFromDb(rows[0])
    });
  } catch (error) {
    if (String(error.message).includes("database_request_failed")) {
      return res.status(500).json({
        success: false,
        message: "ثبت سفارش در پایگاه داده ناموفق بود؛ لطفاً دوباره تلاش کنید"
      });
    }
    console.error("ORDER_CREATE_ERROR:", error.message);
    return res.status(500).json({
      success: false,
      message: "خطا در ثبت سفارش"
    });
  }
});

app.get("/api/orders", async (req, res) => {
  if (!adminAuth.isAdmin(req)) {
    return res.status(401).json({
      success: false,
      message: "برای مشاهده سفارش‌ها باید مدیر وارد شده باشد"
    });
  }

  try {
    const rows = await orderDbRequest(
      "app_orders?select=id,product,price,player_id,tracking,status,created_at&order=created_at.desc&limit=500"
    );
    res.set("Cache-Control", "no-store");
    return res.json({
      success: true,
      count: rows.length,
      orders: rows.map(orderFromDb)
    });
  } catch (error) {
    console.error("ORDER_LIST_ERROR:", error.message);
    return res.status(500).json({
      success: false,
      message: "خواندن سفارش‌ها از پایگاه داده ناموفق بود"
    });
  }
});

app.patch("/api/orders/:id/status", async (req, res) => {
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

  const id = Number(req.params.id);
  const status = String(req.body.status || "").trim();
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ success: false, message: "شماره سفارش نامعتبر است" });
  }

  if (!["pending", "completed", "cancelled"].includes(status)) {
    return res.status(400).json({ success: false, message: "وضعیت نامعتبر است" });
  }

  try {
    const rows = await orderDbRequest(
      "app_orders?id=eq." + id + "&select=id,product,price,player_id,tracking,status,created_at",
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ status })
      }
    );

    if (!Array.isArray(rows) || !rows.length) {
      return res.status(404).json({ success: false, message: "سفارش پیدا نشد" });
    }

    return res.json({
      success: true,
      message: "وضعیت سفارش تغییر کرد",
      order: orderFromDb(rows[0])
    });
  } catch (error) {
    console.error("ORDER_STATUS_ERROR:", error.message);
    return res.status(500).json({
      success: false,
      message: "تغییر وضعیت سفارش ناموفق بود"
    });
  }
});

app.delete("/api/orders/:id", async (req, res) => {
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
    res.set("WWW-Authenticate", 'Basic realm="Arif App Admin"');
    return res.status(401).json({
      success: false,
      message: "دسترسی غیرمجاز"
    });
  }

  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ success: false, message: "شماره سفارش نامعتبر است" });
  }

  try {
    const rows = await orderDbRequest(
      "app_orders?id=eq." + id + "&select=id,product,price,player_id,tracking,status,created_at",
      {
        method: "DELETE",
        headers: { Prefer: "return=representation" }
      }
    );

    if (!Array.isArray(rows) || !rows.length) {
      return res.status(404).json({ success: false, message: "سفارش پیدا نشد" });
    }

    return res.json({
      success: true,
      message: "سفارش حذف شد",
      order: orderFromDb(rows[0])
    });
  } catch (error) {
    console.error("ORDER_DELETE_ERROR:", error.message);
    return res.status(500).json({
      success: false,
      message: "حذف سفارش ناموفق بود"
    });
  }
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


async function adminLoginRateLimitRequest(ip, action) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!base || !key) {
    throw new Error("admin_rate_limit_database_not_configured");
  }

  const response = await fetch(
    base.replace(/\/$/, "") + "/rest/v1/rpc/check_admin_login_attempt",
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        p_ip_address: String(ip).slice(0, 100),
        p_action: action
      })
    }
  );

  const raw = await response.text();
  let data;

  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error("admin_rate_limit_invalid_response");
  }

  if (!response.ok || !Array.isArray(data) || !data[0]) {
    console.error("ADMIN_RATE_LIMIT_DATABASE_ERROR:", response.status);
    throw new Error("admin_rate_limit_request_failed");
  }

  return data[0];
}

function adminLoginKey(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

app.post("/admin/login", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const ip = adminLoginKey(req);
  let limit;

  try {
    limit = await adminLoginRateLimitRequest(ip, "check");
  } catch (e) {
    console.error("ADMIN_RATE_LIMIT_ERROR:", String(e.message || e).slice(0, 120));
    return res.status(503).json({
      success: false,
      message: "بررسی امنیت ورود موقتاً در دسترس نیست؛ بعداً دوباره تلاش کنید."
    });
  }

  if (!limit.allowed) {
    const retryAfter = Math.max(
      1,
      Number(limit.retry_after_seconds) || 900
    );
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({
      success: false,
      message: "تلاش‌های ورود بیش از حد مجاز است؛ بعداً دوباره تلاش کنید."
    });
  }

  const expectedUser = process.env.ADMIN_USER || "";
  const expectedPass = process.env.ADMIN_PASSWORD || "";

  if (!expectedUser || !expectedPass || expectedPass === "change-me") {
    return res.status(503).json({
      success: false,
      message: "تنظیمات مدیر آماده نیست"
    });
  }

  const same = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length &&
      require("crypto").timingSafeEqual(x, y);
  };

  if (
    !same(req.body?.username || "", expectedUser) ||
    !same(req.body?.password || "", expectedPass)
  ) {
    try {
      await adminLoginRateLimitRequest(ip, "fail");
    } catch (e) {
      console.error("ADMIN_RATE_LIMIT_FAIL_ERROR:", String(e.message || e).slice(0, 120));
      return res.status(503).json({
        success: false,
        message: "ثبت تلاش ورود انجام نشد؛ لطفاً دوباره تلاش کنید."
      });
    }

    return res.status(401).json({
      success: false,
      message: "نام کاربری یا رمز نادرست است"
    });
  }

  try {
    await adminLoginRateLimitRequest(ip, "success");

    adminAuth.setSessionCookie(
      res,
      adminAuth.createSession(expectedUser)
    );

    return res.json({ success: true });
  } catch (e) {
    console.error("ADMIN_SESSION_OR_RATE_LIMIT_ERROR:", String(e.message || e).slice(0, 120));
    return res.status(503).json({
      success: false,
      message: "ورود مدیر موقتاً انجام نشد؛ دوباره تلاش کنید."
    });
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

  let orders = [];
  let ordersLoadError = "";
  try {
    const u = process.env.SUPABASE_URL;
    const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!u || !k) {
      ordersLoadError = "تنظیمات پایگاه داده کامل نیست";
    } else {
      const r = await fetch(
        u.replace(/\/$/, "") +
          "/rest/v1/app_orders?select=id,product,price,player_id,tracking,status,created_at&order=created_at.desc&limit=500",
        { headers: { apikey: k, Authorization: "Bearer " + k } }
      );
      if (!r.ok) {
        ordersLoadError = "خواندن سفارش‌ها از پایگاه داده ناموفق بود";
      } else {
        const savedOrders = await r.json();
        orders = savedOrders.map(orderFromDb);
      }
    }
  } catch (_) {
    ordersLoadError = "اتصال به پایگاه داده سفارش‌ها برقرار نشد";
  }

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
${ordersLoadError ? `<p>${escapeHtml(ordersLoadError)}</p>` : ""}
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
  let reason = "";

  if (!secret) reason = "missing_server_secret";
  else if (!match) reason = "missing_bearer_token";
  else {
    try {
      const parts = match[1].split(".");
      if (parts.length !== 2) reason = "malformed_token";
      else {
        const expected = marketCrypto.createHmac("sha256", secret).update(parts[0]).digest();
        const actual = Buffer.from(parts[1], "base64url");
        if (actual.length !== expected.length ||
            !marketCrypto.timingSafeEqual(actual, expected)) reason = "signature_mismatch";
        else {
          const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString());
          if (!payload.email || !Number.isFinite(payload.exp)) reason = "invalid_payload";
          else if (payload.exp <= Math.floor(Date.now() / 1000)) reason = "expired_token";
          else return { email: String(payload.email).trim().toLowerCase() };
        }
      }
    } catch (_) {
      reason = "token_parse_error";
    }
  }

  console.warn("MARKET_AUTH_REJECT:", reason);
  return null;
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


async function marketUploadMedia(base, key, userId, dataUrl, kind) {
  const match = /^data:(image\/(?:jpeg|png|webp)|video\/(?:mp4|quicktime|webm));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!match) throw new Error("فرمت رسانه معتبر نیست");

  const mime = match[1];
  const buffer = Buffer.from(match[2], "base64");
  const isVideo = mime.startsWith("video/");
  const maxBytes = isVideo ? 20000000 : 2500000;

  if (!buffer.length || buffer.length > maxBytes) {
    throw new Error(isVideo ? "حجم ویدیو باید حداکثر ۲۰ مگابایت باشد" : "حجم هر عکس باید حداکثر ۲٫۵ مگابایت باشد");
  }

  const ext = ({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm"
  })[mime];

  const path = String(userId) + "/" + marketCrypto.randomUUID() + "." + ext;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const r = await fetch(base + "/storage/v1/object/marketplace-media/" + encodedPath, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": mime,
      "x-upsert": "false"
    },
    body: buffer
  });

  if (!r.ok) {
    console.error("MARKETPLACE_MEDIA_UPLOAD_ERROR:", r.status, (await r.text()).slice(0, 180));
    throw new Error("آپلود عکس یا ویدیو ناموفق شد؛ تنظیمات Storage را بررسی کنید");
  }
  return path;
}

async function marketSignedMedia(base, key, path) {
  if (!path || /^https?:\/\//i.test(String(path))) return path || "";
  const encodedPath = String(path).split("/").map(encodeURIComponent).join("/");
  const r = await fetch(base + "/storage/v1/object/sign/marketplace-media/" + encodedPath, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ expiresIn: 3600 })
  });

  if (!r.ok) {
    console.error("MARKETPLACE_MEDIA_SIGN_ERROR:", r.status);
    return "";
  }

  const data = await r.json();
  const signed = data.signedURL || data.signedUrl || "";
  if (!signed) return "";
  if (/^https?:\/\//i.test(signed)) return signed;
  const signedPath = signed.startsWith("/") ? signed : "/" + signed;
  return base + (signedPath.startsWith("/storage/v1/") ? signedPath : "/storage/v1" + signedPath);
}

async function marketDeleteUploadedMedia(base, key, paths) {
  const clean = paths.filter(Boolean);
  if (!clean.length) return;
  try {
    await fetch(base + "/storage/v1/object/marketplace-media", {
      method: "DELETE",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ prefixes: clean })
    });
  } catch (_) {}
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

    const rows = await r.json();
    const ads = await Promise.all(rows.map(async ad => {
      const storedPhotos = Array.isArray(ad.photos) ? ad.photos : [];
      const photos = await Promise.all(storedPhotos.map(path => marketSignedMedia(base, key, path)));
      const video_url = await marketSignedMedia(base, key, ad.video_url || "");
      return { ...ad, photos: photos.filter(Boolean), video_url };
    }));

    return res.json({ success: true, ads });
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
  const photos = Array.isArray(req.body.photos) ? req.body.photos : [];
  const video = String(req.body.video || req.body.video_url || "");

  if (!category || !title || title.length > 120 ||
      !Number.isSafeInteger(price) || price < 0 || price > 9000000000000000) {
    return res.status(400).json({ success: false, message: "دسته‌بندی، عنوان یا قیمت معتبر نیست" });
  }
  if (photos.length > 3) {
    return res.status(400).json({ success: false, message: "حداکثر ۳ عکس انتخاب کنید" });
  }
  const totalEncoded = photos.reduce((sum, item) => sum + String(item || "").length, 0) + video.length;
  if (totalEncoded > 33000000) {
    return res.status(413).json({ success: false, message: "حجم مجموع عکس‌ها و ویدیو زیاد است؛ فایل‌های کوچک‌تری انتخاب کنید" });
  }

  let base, key;
  const uploaded = [];

  try {
    ({ base, key } = marketConfig());
    const user = await marketUser(session.email);
    if (!user) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const storedPhotos = [];
    for (const photo of photos) {
      const path = await marketUploadMedia(base, key, user.id, photo, "image");
      uploaded.push(path);
      storedPhotos.push(path);
    }

    let storedVideo = "";
    if (video) {
      storedVideo = await marketUploadMedia(base, key, user.id, video, "video");
      uploaded.push(storedVideo);
    }

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
        photos: storedPhotos,
        video_url: storedVideo,
        seller: session.email
      })
    });

    if (!r.ok) {
      console.error("MARKETPLACE_CREATE_ERROR:", r.status, (await r.text()).slice(0, 200));
      await marketDeleteUploadedMedia(base, key, uploaded);
      return res.status(503).json({ success: false, message: "ثبت آگهی ناموفق بود؛ دوباره تلاش کنید" });
    }

    const rows = await r.json();
    return res.status(201).json({ success: true, ad: rows[0] });
  } catch (e) {
    await marketDeleteUploadedMedia(base || "", key || "", uploaded);
    console.error("MARKETPLACE_CREATE_ERROR:", String(e.message || e).slice(0, 180));
    return res.status(400).json({
      success: false,
      message: String(e.message || "").includes("حجم") || String(e.message || "").includes("فرمت")
        ? String(e.message)
        : "ثبت آگهی یا آپلود رسانه ناموفق شد؛ اتصال و تنظیمات Storage را بررسی کنید"
    });
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



/* ARIF_CHAT_API_V1 */

async function arifChatConversation(conversationId, userId) {
  const { base, key } = marketConfig();
  const q = new URLSearchParams({
    select: "id,user_one_id,user_two_id",
    id: "eq." + conversationId,
    limit: "1"
  });
  const r = await fetch(base + "/rest/v1/chat_conversations?" + q, {
    headers: { apikey: key, Authorization: "Bearer " + key }
  });
  if (!r.ok) throw new Error("chat_conversation_lookup_failed");
  const rows = await r.json();
  const c = Array.isArray(rows) ? rows[0] : null;
  if (!c) return null;
  if (Number(c.user_one_id) !== Number(userId) &&
      Number(c.user_two_id) !== Number(userId)) return null;
  return c;
}

async function arifChatSignedImage(path) {
  const { base, key } = marketConfig();
  const objectPath = String(path || "").split("/").map(encodeURIComponent).join("/");
  const r = await fetch(base + "/storage/v1/object/sign/chat-images/" + objectPath, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ expiresIn: 3600 })
  });
  if (!r.ok) return null;
  const data = await r.json();
  const signed = String(data.signedURL || data.signedUrl || "");
  if (!signed) return null;
  if (/^https?:\/\//i.test(signed)) return signed;
  return base + "/storage/v1" + (signed.startsWith("/") ? signed : "/" + signed);
}

app.post("/api/chat/conversations", async (req, res) => {
  const session = marketSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });
  }

  const adId = String(req.body.ad_id || "").trim();
  if (!adId || adId.length > 100) {
    return res.status(400).json({ success: false, message: "آگهی معتبر نیست" });
  }

  try {
    const { base, key } = marketConfig();
    const me = await marketUser(session.email);
    if (!me) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const aq = new URLSearchParams({
      select: "id,user_id,title",
      id: "eq." + adId,
      limit: "1"
    });
    const ar = await fetch(base + "/rest/v1/marketplace_ads?" + aq, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!ar.ok) throw new Error("chat_ad_lookup_failed");
    const ads = await ar.json();
    const ad = Array.isArray(ads) ? ads[0] : null;
    if (!ad) return res.status(404).json({ success: false, message: "آگهی پیدا نشد" });

    const sellerId = Number(ad.user_id);
    const myId = Number(me.id);
    if (!Number.isSafeInteger(sellerId) || !Number.isSafeInteger(myId)) {
      return res.status(503).json({ success: false, message: "شناسه حساب معتبر نیست" });
    }
    if (sellerId === myId) {
      return res.status(400).json({ success: false, message: "نمی‌توانید به خودتان پیام بدهید" });
    }

    const payload = {
      user_one_id: Math.min(myId, sellerId),
      user_two_id: Math.max(myId, sellerId)
    };
    const cq = new URLSearchParams({ on_conflict: "user_one_id,user_two_id" });
    const cr = await fetch(base + "/rest/v1/chat_conversations?" + cq, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(payload)
    });
    if (!cr.ok) {
      console.error("ARIF_CHAT_CONVERSATION_ERROR:", cr.status, (await cr.text()).slice(0, 200));
      return res.status(503).json({ success: false, message: "ساخت گفت‌وگو ناموفق بود" });
    }
    const rows = await cr.json();
    const conversation = Array.isArray(rows) ? rows[0] : null;
    if (!conversation) {
      return res.status(503).json({ success: false, message: "گفت‌وگو دریافت نشد" });
    }
    return res.json({
      success: true,
      conversation,
      other_user_id: sellerId,
      ad_title: String(ad.title || "")
    });
  } catch (e) {
    console.error("ARIF_CHAT_OPEN_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "اتصال چت برقرار نشد" });
  }
});

app.get("/api/chat/conversations/:id/messages", async (req, res) => {
  const session = marketSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });
  }

  const conversationId = String(req.params.id || "");
  if (!/^[0-9]+$/.test(conversationId)) {
    return res.status(400).json({ success: false, message: "شناسه گفت‌وگو معتبر نیست" });
  }

  try {
    const { base, key } = marketConfig();
    const me = await marketUser(session.email);
    if (!me) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const conversation = await arifChatConversation(conversationId, me.id);
    if (!conversation) {
      return res.status(404).json({ success: false, message: "گفت‌وگو پیدا نشد" });
    }

    const q = new URLSearchParams({
      select: "id,conversation_id,sender_id,message_type,message_text,image_path,created_at",
      conversation_id: "eq." + conversationId,
      order: "created_at.asc",
      limit: "200"
    });
    const r = await fetch(base + "/rest/v1/chat_messages?" + q, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!r.ok) throw new Error("chat_messages_read_failed");
    const messages = await r.json();

    const result = await Promise.all((Array.isArray(messages) ? messages : []).map(async m => ({
      id: m.id,
      conversation_id: m.conversation_id,
      sender_id: m.sender_id,
      message_type: m.message_type,
      message_text: m.message_text,
      image_url: m.message_type === "image" ? await arifChatSignedImage(m.image_path) : null,
      created_at: m.created_at
    })));

    return res.json({ success: true, messages: result });
  } catch (e) {
    console.error("ARIF_CHAT_MESSAGES_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "دریافت پیام‌ها ناموفق بود" });
  }
});

app.post("/api/chat/conversations/:id/messages", async (req, res) => {
  const session = marketSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });
  }

  const conversationId = String(req.params.id || "");
  const messageText = String(req.body.message_text || "").trim();
  if (!/^[0-9]+$/.test(conversationId)) {
    return res.status(400).json({ success: false, message: "شناسه گفت‌وگو معتبر نیست" });
  }
  if (!messageText || messageText.length > 5000) {
    return res.status(400).json({ success: false, message: "پیام باید بین ۱ تا ۵۰۰۰ حرف باشد" });
  }

  try {
    const { base, key } = marketConfig();
    const me = await marketUser(session.email);
    if (!me) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const conversation = await arifChatConversation(conversationId, me.id);
    if (!conversation) {
      return res.status(404).json({ success: false, message: "گفت‌وگو پیدا نشد" });
    }

    const r = await fetch(base + "/rest/v1/chat_messages", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        conversation_id: Number(conversationId),
        sender_id: me.id,
        message_type: "text",
        message_text: messageText,
        image_path: null
      })
    });
    if (!r.ok) {
      console.error("ARIF_CHAT_SEND_ERROR:", r.status, (await r.text()).slice(0, 200));
      return res.status(503).json({ success: false, message: "ذخیره پیام ناموفق بود" });
    }

    await fetch(base + "/rest/v1/chat_conversations?id=eq." + encodeURIComponent(conversationId), {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ last_message_at: new Date().toISOString() })
    });

    const rows = await r.json();
    return res.status(201).json({ success: true, message: Array.isArray(rows) ? rows[0] : null });
  } catch (e) {
    console.error("ARIF_CHAT_SEND_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "ارسال پیام ناموفق بود" });
  }
});

app.post("/api/chat/conversations/:id/images", async (req, res) => {
  const session = marketSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });
  }

  const conversationId = String(req.params.id || "");
  const dataUrl = String(req.body.image_data || "");
  if (!/^[0-9]+$/.test(conversationId)) {
    return res.status(400).json({ success: false, message: "شناسه گفت‌وگو معتبر نیست" });
  }

  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) {
    return res.status(400).json({ success: false, message: "عکس باید JPG یا PNG یا WEBP باشد" });
  }
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!buffer.length || buffer.length > 2500000) {
    return res.status(400).json({ success: false, message: "حجم عکس نباید بیشتر از ۲٫۵ مگابایت باشد" });
  }

  try {
    const { base, key } = marketConfig();
    const me = await marketUser(session.email);
    if (!me) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const conversation = await arifChatConversation(conversationId, me.id);
    if (!conversation) {
      return res.status(404).json({ success: false, message: "گفت‌وگو پیدا نشد" });
    }

    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[match[1]];
    const imagePath = conversationId + "/" + me.id + "/" + require("crypto").randomUUID() + "." + ext;
    const storageUrl = base + "/storage/v1/object/chat-images/" +
      imagePath.split("/").map(encodeURIComponent).join("/");

    const upload = await fetch(storageUrl, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": match[1],
        "x-upsert": "false"
      },
      body: buffer
    });

    if (!upload.ok) {
      console.error("ARIF_CHAT_IMAGE_UPLOAD_ERROR:", upload.status);
      return res.status(503).json({
        success: false,
        message: "آپلود عکس انجام نشد؛ باکت خصوصی chat-images را در Supabase بسازید"
      });
    }

    const r = await fetch(base + "/rest/v1/chat_messages", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        conversation_id: Number(conversationId),
        sender_id: me.id,
        message_type: "image",
        message_text: null,
        image_path: imagePath
      })
    });

    if (!r.ok) {
      await fetch(storageUrl, {
        method: "DELETE",
        headers: { apikey: key, Authorization: "Bearer " + key }
      }).catch(() => {});
      console.error("ARIF_CHAT_IMAGE_DB_ERROR:", r.status, (await r.text()).slice(0, 200));
      return res.status(503).json({ success: false, message: "ثبت عکس در گفت‌وگو ناموفق بود" });
    }

    await fetch(base + "/rest/v1/chat_conversations?id=eq." + encodeURIComponent(conversationId), {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ last_message_at: new Date().toISOString() })
    });

    const rows = await r.json();
    const message = Array.isArray(rows) ? rows[0] : null;
    return res.status(201).json({
      success: true,
      message: message ? {
        id: message.id,
        conversation_id: message.conversation_id,
        sender_id: message.sender_id,
        message_type: "image",
        image_url: await arifChatSignedImage(imagePath),
        created_at: message.created_at
      } : null
    });
  } catch (e) {
    console.error("ARIF_CHAT_IMAGE_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "ارسال عکس ناموفق بود" });
  }
});



/* ARIF_AWARENESS_API_V1 */

async function arifAwarenessSignedMedia(path) {
  const { base, key } = marketConfig();
  const objectPath = String(path || "").split("/").map(encodeURIComponent).join("/");
  const r = await fetch(
    base + "/storage/v1/object/sign/awareness-media/" + objectPath,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ expiresIn: 3600 })
    }
  );
  if (!r.ok) return null;
  const data = await r.json();
  const signed = String(data.signedURL || data.signedUrl || "");
  if (!signed) return null;
  if (/^https?:\/\//i.test(signed)) return signed;
  return base + "/storage/v1" + (signed.startsWith("/") ? signed : "/" + signed);
}

app.get("/api/awareness/posts", async (req, res) => {
  try {
    const { base, key } = marketConfig();
    const q = new URLSearchParams({
      select: "id,user_id,content,media_type,media_path,created_at",
      order: "created_at.desc",
      limit: "100"
    });
    const r = await fetch(base + "/rest/v1/awareness_posts?" + q, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!r.ok) throw new Error("awareness_posts_read_failed");

    const rows = await r.json();

    let currentUserId = null;
    try {
      const session = marketSession(req);
      if (session) {
        const currentUser = await marketUser(session.email);
        if (currentUser) currentUserId = String(currentUser.id);
      }
    } catch (_) {}

    const posts = await Promise.all((Array.isArray(rows) ? rows : []).map(async post => ({
      id: post.id,
      user_id: post.user_id,
      is_owner: currentUserId !== null && currentUserId === String(post.user_id),
      author: "کاربر #" + post.user_id,
      content: post.content || "",
      media_type: post.media_type || "text",
      media_url: post.media_path ? await arifAwarenessSignedMedia(post.media_path) : null,
      created_at: post.created_at
    })));

    return res.json({ success: true, posts });
  } catch (e) {
    console.error("AWARENESS_LIST_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({
      success: false,
      message: "دریافت پست‌های آگاهی ناموفق بود"
    });
  }
});

app.post("/api/awareness/posts", async (req, res) => {
  let uploadedPath = null;

  try {
    const session = marketSession(req);
    if (!session) {
      return res.status(401).json({
        success: false,
        message: "ابتدا وارد حساب شوید"
      });
    }

    const user = await marketUser(session.email);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "حساب کاربری پیدا نشد"
      });
    }

    const content = String(req.body.content || "").trim();
    const dataUrl = String(req.body.media_data || "");
    let mediaType = "text";
    let mediaPath = null;
    let mediaBuffer = null;
    let mime = "";

    if (content.length > 5000) {
      return res.status(400).json({
        success: false,
        message: "متن پست نباید بیشتر از ۵۰۰۰ حرف باشد"
      });
    }

    if (dataUrl) {
      const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp)|video\/(?:mp4|quicktime|webm));base64,([A-Za-z0-9+/=\r\n]+)$/);
      if (!match) {
        return res.status(400).json({
          success: false,
          message: "نوع فایل پشتیبانی نمی‌شود"
        });
      }

      mime = match[1];
      mediaBuffer = Buffer.from(match[2], "base64");

      if (!mediaBuffer.length || mediaBuffer.length > 2500000) {
        return res.status(400).json({
          success: false,
          message: "حجم عکس یا ویدیو باید حداکثر ۲٫۵ مگابایت باشد"
        });
      }

      mediaType = mime.startsWith("image/") ? "image" : "video";

      const extByMime = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "video/mp4": "mp4",
        "video/quicktime": "mov",
        "video/webm": "webm"
      };
      const crypto = require("crypto");
      mediaPath = "awareness/" + user.id + "/" +
        crypto.randomUUID() + "." + extByMime[mime];

      const { base, key } = marketConfig();
      const objectPath = mediaPath.split("/").map(encodeURIComponent).join("/");
      const upload = await fetch(
        base + "/storage/v1/object/awareness-media/" + objectPath,
        {
          method: "POST",
          headers: {
            apikey: key,
            Authorization: "Bearer " + key,
            "Content-Type": mime,
            "x-upsert": "false"
          },
          body: mediaBuffer
        }
      );

      if (!upload.ok) {
        const detail = await upload.text().catch(() => "");
        console.error("AWARENESS_UPLOAD_ERROR:", upload.status, detail.slice(0, 200));
        return res.status(503).json({
          success: false,
          message: "ذخیره عکس یا ویدیو ناموفق بود؛ تنظیمات باکت را بررسی کنید"
        });
      }
      uploadedPath = mediaPath;
    }

    if (!content && !mediaPath) {
      return res.status(400).json({
        success: false,
        message: "متن یا عکس یا ویدیو وارد کنید"
      });
    }

    const { base, key } = marketConfig();
    const insert = await fetch(base + "/rest/v1/awareness_posts", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify([{
        user_id: user.id,
        content,
        media_type: mediaType,
        media_path: mediaPath
      }])
    });

    if (!insert.ok) {
      const detail = await insert.text().catch(() => "");
      console.error("AWARENESS_INSERT_ERROR:", insert.status, detail.slice(0, 200));

      if (uploadedPath) {
        const objectPath = uploadedPath.split("/").map(encodeURIComponent).join("/");
        await fetch(base + "/storage/v1/object/awareness-media/" + objectPath, {
          method: "DELETE",
          headers: { apikey: key, Authorization: "Bearer " + key }
        }).catch(() => {});
      }

      return res.status(503).json({
        success: false,
        message: "ذخیره پست در پایگاه داده ناموفق بود"
      });
    }

    const rows = await insert.json();
    const post = Array.isArray(rows) ? rows[0] : null;

    return res.status(201).json({
      success: true,
      post: post ? {
        id: post.id,
        user_id: post.user_id,
        author: "کاربر #" + post.user_id,
        content: post.content || "",
        media_type: post.media_type || "text",
        media_url: post.media_path ? await arifAwarenessSignedMedia(post.media_path) : null,
        created_at: post.created_at
      } : null
    });
  } catch (e) {
    console.error("AWARENESS_CREATE_ERROR:", String(e.message || e).slice(0, 180));
    return res.status(503).json({
      success: false,
      message: "ثبت پست آگاهی ناموفق بود"
    });
  }
});


app.delete("/api/awareness/posts/:id", async (req, res) => {
  try {
    const session = marketSession(req);
    if (!session) {
      return res.status(401).json({
        success: false,
        message: "برای حذف آگاهی ابتدا وارد حساب شوید"
      });
    }

    const user = await marketUser(session.email);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "حساب کاربری پیدا نشد"
      });
    }

    const postId = String(req.params.id || "").trim();
    if (!postId || postId.length > 100) {
      return res.status(400).json({ success: false, message: "شناسه آگاهی نامعتبر است" });
    }

    const { base, key } = marketConfig();
    const lookup = new URLSearchParams({
      select: "id,user_id,media_path",
      id: "eq." + postId,
      limit: "1"
    });

    const found = await fetch(base + "/rest/v1/awareness_posts?" + lookup, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });

    if (!found.ok) throw new Error("awareness_post_lookup_failed");

    const rows = await found.json();
    const post = Array.isArray(rows) ? rows[0] : null;

    if (!post) {
      return res.status(404).json({ success: false, message: "آگاهی پیدا نشد یا قبلاً حذف شده است" });
    }

    if (String(post.user_id) !== String(user.id)) {
      return res.status(403).json({
        success: false,
        message: "شما فقط می‌توانید آگاهی خودتان را حذف کنید"
      });
    }

    const deleteQuery = new URLSearchParams({
      id: "eq." + String(post.id),
      user_id: "eq." + String(user.id)
    });

    const deleted = await fetch(base + "/rest/v1/awareness_posts?" + deleteQuery, {
      method: "DELETE",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        Prefer: "return=representation"
      }
    });

    if (!deleted.ok) {
      const detail = await deleted.text().catch(() => "");
      console.error("AWARENESS_DELETE_ERROR:", deleted.status, detail.slice(0, 150));
      throw new Error("awareness_post_delete_failed");
    }

    const deletedRows = await deleted.json().catch(() => []);
    if (!Array.isArray(deletedRows) || deletedRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "آگاهی حذف نشد؛ لطفاً دوباره تلاش کنید"
      });
    }

    if (post.media_path) {
      try {
        const objectPath = String(post.media_path).split("/").map(encodeURIComponent).join("/");
        const mediaDelete = await fetch(
          base + "/storage/v1/object/awareness-media/" + objectPath,
          {
            method: "DELETE",
            headers: { apikey: key, Authorization: "Bearer " + key }
          }
        );
        if (!mediaDelete.ok) {
          console.error("AWARENESS_MEDIA_DELETE_ERROR:", mediaDelete.status);
        }
      } catch (mediaError) {
        console.error("AWARENESS_MEDIA_DELETE_ERROR:", String(mediaError.message || mediaError).slice(0, 120));
      }
    }

    return res.json({ success: true, message: "آگاهی حذف شد" });
  } catch (e) {
    console.error("AWARENESS_DELETE_ERROR:", String(e.message || e).slice(0, 160));
    return res.status(503).json({
      success: false,
      message: "حذف آگاهی ناموفق بود؛ لطفاً دوباره تلاش کنید"
    });
  }
});

/* END ARIF_AWARENESS_API_V1 */


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
