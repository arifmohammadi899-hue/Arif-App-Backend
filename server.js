require("dotenv").config();
const express = require("express");

const app = express();
app.set("trust proxy", 1);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === "null") {
    res.setHeader("Access-Control-Allow-Origin", "null");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
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
  if (!adminAuth.isAdmin(req)) {
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
  if (!adminAuth.isAdmin(req)) {
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
  if (!adminAuth.isAdmin(req)) {
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
  console.log("ADMIN_IP_DIAGNOSTIC:", JSON.stringify({
    ip: req.ip || null,
    remoteAddress: req.socket?.remoteAddress || null,
    forwardedForPresent: Boolean(req.headers["x-forwarded-for"])
  }));
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
<h2>مشاهده پیام‌های کاربران</h2>
<p>این بخش فقط برای مدیر واردشده قابل دسترسی است.</p>
<button type="button" id="admin-chat-load">بارگذاری گفت‌وگوها</button>
<p id="admin-chat-status" role="status"></p>
<div id="admin-chat-list"></div>
<h3>پیام‌های گفت‌وگوی انتخاب‌شده</h3>
<div id="admin-chat-messages"></div>

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
const adminChatStatus = document.getElementById("admin-chat-status");
const adminChatList = document.getElementById("admin-chat-list");
const adminChatMessages = document.getElementById("admin-chat-messages");

function adminChatText(tag, value) {
  const el = document.createElement(tag);
  el.textContent = value == null ? "" : String(value);
  return el;
}

document.getElementById("admin-chat-load").addEventListener("click", async function () {
  adminChatStatus.textContent = "در حال دریافت گفت‌وگوها...";
  adminChatList.replaceChildren();
  adminChatMessages.replaceChildren();

  try {
    const response = await fetch("/admin/api/chat/conversations", {
      credentials: "same-origin",
      cache: "no-store"
    });
    const body = await response.json();
    if (!response.ok || !body.success) {
      throw new Error(body.message || "دریافت گفت‌وگوها ناموفق بود");
    }

    if (!body.conversations.length) {
      adminChatStatus.textContent = "گفت‌وگویی پیدا نشد.";
      return;
    }

    body.conversations.forEach(function (c) {
      const box = document.createElement("div");
      box.style.cssText = "border:1px solid #777;padding:10px;margin:8px 0";
      box.appendChild(adminChatText("p",
        "گفت‌وگو #" + c.id + " — " +
        (c.user_one_email || ("کاربر " + c.user_one_id)) + " ↔ " +
        (c.user_two_email || ("کاربر " + c.user_two_id))
      ));
      box.appendChild(adminChatText("small",
        "آخرین فعالیت: " + (c.last_message_at || c.created_at || "نامشخص")
      ));

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "نمایش پیام‌ها";
      button.addEventListener("click", async function () {
        adminChatMessages.replaceChildren();
        adminChatStatus.textContent = "در حال دریافت پیام‌ها...";
        try {
          const r = await fetch(
            "/admin/api/chat/conversations/" + encodeURIComponent(c.id) + "/messages",
            { credentials: "same-origin", cache: "no-store" }
          );
          const data = await r.json();
          if (!r.ok || !data.success) {
            throw new Error(data.message || "دریافت پیام‌ها ناموفق بود");
          }

          if (!data.messages.length) {
            adminChatStatus.textContent = "این گفت‌وگو پیامی ندارد.";
            return;
          }

          data.messages.forEach(function (m) {
            const item = document.createElement("div");
            item.style.cssText = "border-bottom:1px solid #aaa;padding:8px;margin:4px 0";
            item.appendChild(adminChatText("p",
              (m.sender_email || ("کاربر " + m.sender_id)) + " — " +
              (m.created_at || "") + " — " + (m.message_type || "text")
            ));
            if (m.message_text) item.appendChild(adminChatText("p", m.message_text));

            if (m.image_url) {
              const link = document.createElement("a");
              link.href = m.image_url;
              link.target = "_blank";
              link.rel = "noopener noreferrer";
              link.textContent = "مشاهده تصویر خصوصی";
              item.appendChild(link);
            }
            adminChatMessages.appendChild(item);
          });
          adminChatStatus.textContent = "پیام‌ها بارگذاری شدند.";
        } catch (e) {
          adminChatStatus.textContent = e.message || "خطا در دریافت پیام‌ها";
        }
      });

      box.appendChild(button);
      adminChatList.appendChild(box);
    });

    adminChatStatus.textContent =
      "تعداد گفت‌وگوهای بارگذاری‌شده: " + body.conversations.length;
  } catch (e) {
    adminChatStatus.textContent = e.message || "خطا در دریافت گفت‌وگوها";
  }
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
      select: "id,user_id,category,title,price,currency,description,phone,city,address,latitude,longitude,photos,video_url,seller,created_at",
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
  const currency = String(req.body.currency || "AFN").trim().toUpperCase();
  const description = String(req.body.description || "").trim().slice(0, 5000);
  const phone = String(req.body.phone || "").trim().slice(0, 25);
  const city = String(req.body.city || "").trim().slice(0, 100);
  const address = String(req.body.address || "").trim().slice(0, 300);
  const hasLatitude = req.body.latitude !== null && req.body.latitude !== undefined && String(req.body.latitude).trim() !== "";
  const hasLongitude = req.body.longitude !== null && req.body.longitude !== undefined && String(req.body.longitude).trim() !== "";
  const latitude = hasLatitude ? Number(req.body.latitude) : null;
  const longitude = hasLongitude ? Number(req.body.longitude) : null;
  const photos = Array.isArray(req.body.photos) ? req.body.photos : [];
  const video = String(req.body.video || req.body.video_url || "");

  if (!category || !title || title.length > 120 ||
      !Number.isSafeInteger(price) || price < 0 || price > 9000000000000000) {
    return res.status(400).json({ success: false, message: "دسته‌بندی، عنوان یا قیمت معتبر نیست" });
  }
  if (!["AFN", "IRR"].includes(currency)) {
    return res.status(400).json({ success: false, message: "واحد پول معتبر نیست" });
  }
  if (hasLatitude !== hasLongitude ||
      (hasLatitude && (
        !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      ))) {
    return res.status(400).json({ success: false, message: "موقعیت مکانی معتبر نیست" });
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
        currency,
        description,
        phone,
        city,
        address,
        latitude,
        longitude,
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

/* SAVED_MARKETPLACE_API_V1 */
function validSavedAdId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

app.get("/api/marketplace/saved", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const session = marketSession(req);
  if (!session) return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });

  try {
    const { base, key } = marketConfig();
    const user = await marketUser(session.email);
    if (!user) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const sq = new URLSearchParams({
      select: "ad_id,created_at",
      user_id: "eq." + user.id,
      order: "created_at.desc"
    });
    const sr = await fetch(base + "/rest/v1/saved_marketplace_ads?" + sq, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!sr.ok) throw new Error("saved_ads_lookup_failed");

    const savedRows = await sr.json();
    if (!Array.isArray(savedRows) || !savedRows.length) {
      return res.json({ success: true, ads: [] });
    }

    const ids = savedRows.map(row => row.ad_id).filter(validSavedAdId);
    if (!ids.length) return res.json({ success: true, ads: [] });

    const aq = new URLSearchParams({
      select: "id,user_id,category,title,price,currency,description,phone,city,address,latitude,longitude,photos,video_url,seller,created_at",
      id: "in.(" + ids.join(",") + ")"
    });
    const ar = await fetch(base + "/rest/v1/marketplace_ads?" + aq, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!ar.ok) throw new Error("saved_ad_details_lookup_failed");

    const rows = await ar.json();
    const byId = new Map(rows.map(ad => [String(ad.id), ad]));
    const ads = [];

    for (const saved of savedRows) {
      const ad = byId.get(String(saved.ad_id));
      if (!ad) continue;
      const photos = await Promise.all(
        (Array.isArray(ad.photos) ? ad.photos : []).map(path => marketSignedMedia(base, key, path))
      );
      const video_url = await marketSignedMedia(base, key, ad.video_url || "");
      ads.push({ ...ad, photos: photos.filter(Boolean), video_url, saved_at: saved.created_at });
    }

    return res.json({ success: true, ads });
  } catch (e) {
    console.error("SAVED_MARKETPLACE_LIST_ERROR:", String(e.message || e).slice(0, 160));
    return res.status(503).json({ success: false, message: "دریافت آگهی‌های ذخیره‌شده ناموفق بود" });
  }
});

app.post("/api/marketplace/saved/:id", async (req, res) => {
  const session = marketSession(req);
  if (!session) return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });

  const id = String(req.params.id || "");
  if (!validSavedAdId(id)) return res.status(400).json({ success: false, message: "شناسه آگهی معتبر نیست" });

  try {
    const { base, key } = marketConfig();
    const user = await marketUser(session.email);
    if (!user) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const q = new URLSearchParams({ on_conflict: "user_id,ad_id" });
    const r = await fetch(base + "/rest/v1/saved_marketplace_ads?" + q, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({ user_id: user.id, ad_id: id })
    });
    if (!r.ok) {
      console.error("SAVED_MARKETPLACE_ADD_ERROR:", r.status, (await r.text()).slice(0, 160));
      return res.status(503).json({ success: false, message: "ذخیره آگهی ناموفق بود" });
    }
    return res.json({ success: true, saved: true });
  } catch (e) {
    console.error("SAVED_MARKETPLACE_ADD_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "اتصال بازار آنلاین برقرار نشد" });
  }
});

app.delete("/api/marketplace/saved/:id", async (req, res) => {
  const session = marketSession(req);
  if (!session) return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });

  const id = String(req.params.id || "");
  if (!validSavedAdId(id)) return res.status(400).json({ success: false, message: "شناسه آگهی معتبر نیست" });

  try {
    const { base, key } = marketConfig();
    const user = await marketUser(session.email);
    if (!user) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const q = new URLSearchParams({ user_id: "eq." + user.id, ad_id: "eq." + id });
    const r = await fetch(base + "/rest/v1/saved_marketplace_ads?" + q, {
      method: "DELETE",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        Prefer: "return=minimal"
      }
    });
    if (!r.ok) {
      console.error("SAVED_MARKETPLACE_REMOVE_ERROR:", r.status);
      return res.status(503).json({ success: false, message: "حذف از ذخیره‌ها ناموفق بود" });
    }
    return res.json({ success: true, saved: false });
  } catch (e) {
    console.error("SAVED_MARKETPLACE_REMOVE_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "اتصال بازار آنلاین برقرار نشد" });
  }
});
/* END SAVED_MARKETPLACE_API_V1 */

/* ARIF_JOB_ADS_API_V1 */

// نمایش آگهی‌های استخدام و جویای کار
app.get("/api/job-ads", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const auth = String(req.headers.authorization || "");
    const session = auth ? marketSession(req) : null;
    let myUserId = null;

    if (session) {
      const user = await marketUser(session.email);
      if (user) myUserId = user.id;
    }

    const { base, key } = marketConfig();
    const q = new URLSearchParams({
      select: "id,user_id,ad_type,title,description,city,address,salary,phone,contact_name,created_at",
      order: "created_at.desc"
    });

    const r = await fetch(base + "/rest/v1/job_ads?" + q, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });

    if (!r.ok) {
      console.error("JOB_ADS_LIST_ERROR:", r.status);
      return res.status(503).json({ success: false, message: "دریافت آگهی‌های کار ناموفق بود" });
    }

    const rows = await r.json();
    const ads = rows.map(ad => ({
      ...ad,
      is_mine: myUserId !== null && String(ad.user_id) === String(myUserId)
    }));
    return res.json({ success: true, ads });
  } catch (e) {
    console.error("JOB_ADS_LIST_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "اتصال آگهی کار برقرار نشد" });
  }
});

// ثبت آگهی استخدام یا جویای کار
app.post("/api/job-ads", async (req, res) => {
  const session = marketSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });
  }

  const body = req.body || {};
  const adType = String(body.ad_type || "");
  const title = String(body.title || "").trim().slice(0, 120);
  const description = String(body.description || "").trim().slice(0, 3000);
  const city = String(body.city || "").trim().slice(0, 100);
  const address = String(body.address || "").trim().slice(0, 250);
  const salary = String(body.salary || "").trim().slice(0, 100);
  const phone = String(body.phone || "").trim().slice(0, 40);
  const contactName = String(body.contact_name || "").trim().slice(0, 100);

  if (!["hire", "seeking"].includes(adType)) {
    return res.status(400).json({ success: false, message: "نوع آگهی معتبر نیست" });
  }
  if (!title || !city || !phone) {
    return res.status(400).json({ success: false, message: "عنوان، شهر و شماره تماس الزامی است" });
  }

  try {
    const { base, key } = marketConfig();
    const user = await marketUser(session.email);
    if (!user) {
      return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });
    }

    const r = await fetch(base + "/rest/v1/job_ads", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        user_id: user.id,
        ad_type: adType,
        title,
        description,
        city,
        address,
        salary,
        phone,
        contact_name: contactName
      })
    });

    if (!r.ok) {
      console.error("JOB_ADS_CREATE_ERROR:", r.status, (await r.text()).slice(0, 180));
      return res.status(503).json({ success: false, message: "ثبت آگهی کار ناموفق بود" });
    }

    const rows = await r.json();
    return res.status(201).json({ success: true, ad: rows[0] });
  } catch (e) {
    console.error("JOB_ADS_CREATE_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "ثبت آگهی کار ناموفق بود" });
  }
});

// حذف آگهی فقط توسط صاحب آن
app.delete("/api/job-ads/:id", async (req, res) => {
  const session = marketSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });
  }

  const id = String(req.params.id || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ success: false, message: "شناسه آگهی معتبر نیست" });
  }

  try {
    const { base, key } = marketConfig();
    const user = await marketUser(session.email);
    if (!user) {
      return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });
    }

    const q = new URLSearchParams({
      id: "eq." + id,
      user_id: "eq." + user.id
    });

    const r = await fetch(base + "/rest/v1/job_ads?" + q, {
      method: "DELETE",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        Prefer: "return=representation"
      }
    });

    if (!r.ok) {
      console.error("JOB_ADS_DELETE_ERROR:", r.status);
      return res.status(503).json({ success: false, message: "حذف آگهی کار ناموفق بود" });
    }

    const rows = await r.json();
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "آگهی پیدا نشد یا متعلق به شما نیست" });
    }

    return res.json({ success: true });
  } catch (e) {
    console.error("JOB_ADS_DELETE_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "حذف آگهی کار ناموفق بود" });
  }
});

/* END ARIF_JOB_ADS_API_V1 */


/* END MARKETPLACE_API_V1 */



/* ARIF_CHAT_API_V1 */

async function arifChatConversation(conversationId, userId) {
  const { base, key } = marketConfig();
  const q = new URLSearchParams({
    select: "id,user_one_id,user_two_id,disappearing_seconds",
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

function arifChatOtherUserId(conversation, userId) {
  const me = Number(userId);
  const one = Number(conversation.user_one_id);
  const two = Number(conversation.user_two_id);
  if (me === one) return two;
  if (me === two) return one;
  return null;
}

async function arifChatIsBlocked(conversation, userId) {
  const { base, key } = marketConfig();
  const otherId = arifChatOtherUserId(conversation, userId);
  if (!otherId) throw new Error("chat_other_user_not_found");

  const me = Number(userId);
  const q = new URLSearchParams({
    select: "id",
    or: `(and(blocker_id.eq.${me},blocked_user_id.eq.${otherId}),and(blocker_id.eq.${otherId},blocked_user_id.eq.${me}))`,
    limit: "1"
  });

  const r = await fetch(base + "/rest/v1/chat_blocks?" + q, {
    headers: { apikey: key, Authorization: "Bearer " + key }
  });
  if (!r.ok) throw new Error("chat_block_lookup_failed");
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
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


app.get("/api/chat/conversations", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const session = marketSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });
  }

  try {
    const { base, key } = marketConfig();
    const me = await marketUser(session.email);
    if (!me) {
      return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });
    }

    const myId = Number(me.id);
    const q = new URLSearchParams({
      select: "id,user_one_id,user_two_id,conversation_type,created_at,last_message_at",
      or: "(user_one_id.eq." + myId + ",user_two_id.eq." + myId + ")",
      order: "last_message_at.desc.nullslast",
      limit: "100"
    });

    const r = await fetch(base + "/rest/v1/chat_conversations?" + q, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!r.ok) throw new Error("chat_conversations_read_failed");

    const rows = await r.json();
    const conversations = Array.isArray(rows) ? rows : [];
    if (!conversations.length) {
      return res.json({ success: true, conversations: [] });
    }

    const ids = [...new Set(conversations.map(c => String(
      Number(c.user_one_id) === myId ? c.user_two_id : c.user_one_id
    )).filter(id => /^[0-9]+$/.test(id)))];

    const uq = new URLSearchParams({
      select: "id,phone,first_name,surname,username",
      id: "in.(" + ids.join(",") + ")"
    });
    const ur = await fetch(base + "/rest/v1/app_users?" + uq, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!ur.ok) throw new Error("chat_users_read_failed");

    const users = await ur.json();
    const userById = new Map((Array.isArray(users) ? users : [])
      .map(u => [String(u.id), u]));

    const conversationIds = conversations.map(c => String(c.id));
    const mq = new URLSearchParams({
      select: "id,conversation_id,sender_id,message_type,message_text,created_at",
      conversation_id: "in.(" + conversationIds.join(",") + ")",
      order: "created_at.desc",
      limit: "500"
    });
    const mr = await fetch(base + "/rest/v1/chat_messages?" + mq, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!mr.ok) throw new Error("chat_messages_read_failed");

    const messages = await mr.json();
    const lastByConversation = new Map();
    for (const m of (Array.isArray(messages) ? messages : [])) {
      const id = String(m.conversation_id);
      if (!lastByConversation.has(id)) lastByConversation.set(id, m);
    }

    return res.json({
      success: true,
      conversations: conversations.map(c => {
        const otherId = String(
          Number(c.user_one_id) === myId ? c.user_two_id : c.user_one_id
        );
        const other = userById.get(otherId) || {};
        const last = lastByConversation.get(String(c.id));
        const otherName = [other.first_name, other.surname]
          .filter(Boolean).join(" ").trim() || String(other.username || "");

        return {
          id: c.id,
          conversation_type: c.conversation_type,
          other_user_id: otherId,
          other_user_name: otherName,
          other_user_phone: String(other.phone || ""),
          last_message: last
            ? (last.message_type === "image" ? "🖼️ عکس" : String(last.message_text || "").slice(0, 120))
            : "هنوز پیامی ارسال نشده",
          last_message_at: last ? last.created_at : c.last_message_at
        };
      })
    });
  } catch (e) {
    console.error("ARIF_CHAT_LIST_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({
      success: false,
      message: "دریافت صندوق پیام ناموفق بود"
    });
  }
});

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
      user_two_id: Math.max(myId, sellerId),
      conversation_type: "marketplace"
    };
    const cq = new URLSearchParams({ on_conflict: "user_one_id,user_two_id,conversation_type" });
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


/* ARIF_PRIVATE_CONTACTS_V1 */

// تطبیق شماره مخاطبان با کاربران تأییدشده؛ فهرست مخاطبان ذخیره نمی‌شود.
app.post("/api/chat/match-contacts", async (req, res) => {
  const session = marketSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });
  }

  try {
    const input = Array.isArray(req.body?.phones) ? req.body.phones.slice(0, 500) : [];
    const phones = [...new Set(input.map(value => {
      let phone = String(value || "").replace(/[\s()-]/g, "");
      if (phone.startsWith("00")) phone = "+" + phone.slice(2);
      if (!phone.startsWith("+")) phone = "+" + phone;
      return /^\+[0-9]{8,15}$/.test(phone) ? phone : "";
    }).filter(Boolean))];

    if (!phones.length) {
      return res.json({ success: true, users: [] });
    }

    const { base, key } = marketConfig();
    const me = await marketUser(session.email);
    if (!me) {
      return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });
    }

    const q = new URLSearchParams({
      select: "id,phone,first_name,surname,username",
      phone_verified: "eq.true",
      phone: "in.(" + phones.join(",") + ")",
      limit: "500"
    });

    const r = await fetch(base + "/rest/v1/app_users?" + q, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });

    if (!r.ok) throw new Error("contact_match_query_failed");

    const rows = await r.json();
    const users = (Array.isArray(rows) ? rows : [])
      .filter(u => String(u.id) !== String(me.id))
      .map(u => ({
        id: u.id,
        phone: String(u.phone || ""),
        name: [u.first_name, u.surname].filter(Boolean).join(" ").trim()
          || String(u.username || "کاربر عارف")
      }));

    return res.json({ success: true, users });
  } catch (e) {
    console.error("ARIF_CONTACT_MATCH_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "پیدا کردن مخاطبان ناموفق بود" });
  }
});

// ساخت گفتگوی خصوصی مستقل از گفتگوی آگهی
app.post("/api/chat/private-conversations", async (req, res) => {
  const session = marketSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });
  }

  try {
    const targetId = Number(req.body?.user_id);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ success: false, message: "شناسه کاربر معتبر نیست" });
    }

    const { base, key } = marketConfig();
    const me = await marketUser(session.email);
    if (!me) {
      return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });
    }

    const myId = Number(me.id);
    if (!Number.isSafeInteger(myId) || targetId === myId) {
      return res.status(400).json({ success: false, message: "نمی‌توانید به خودتان پیام بدهید" });
    }

    const uq = new URLSearchParams({
      select: "id,phone_verified,first_name,surname,username",
      id: "eq." + targetId,
      phone_verified: "eq.true",
      limit: "1"
    });

    const ur = await fetch(base + "/rest/v1/app_users?" + uq, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });

    if (!ur.ok) throw new Error("private_chat_user_lookup_failed");

    const targetRows = await ur.json();
    const target = Array.isArray(targetRows) ? targetRows[0] : null;

    if (!target) {
      return res.status(404).json({ success: false, message: "کاربر تأییدشده پیدا نشد" });
    }

    const payload = {
      user_one_id: Math.min(myId, targetId),
      user_two_id: Math.max(myId, targetId),
      conversation_type: "private"
    };

    const cq = new URLSearchParams({
      on_conflict: "user_one_id,user_two_id,conversation_type"
    });

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

    if (!cr.ok) throw new Error("private_chat_create_failed");

    const rows = await cr.json();
    const conversation = Array.isArray(rows) ? rows[0] : null;

    if (!conversation) {
      return res.status(503).json({ success: false, message: "گفتگوی خصوصی ساخته نشد" });
    }

    const name = [target.first_name, target.surname].filter(Boolean).join(" ").trim()
      || String(target.username || "کاربر عارف");

    return res.json({
      success: true,
      conversation,
      other_user_id: targetId,
      other_user_name: name
    });
  } catch (e) {
    console.error("ARIF_PRIVATE_CHAT_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "ساخت گفتگوی خصوصی ناموفق بود" });
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

    if (await arifChatIsBlocked(conversation, me.id)) {
      return res.status(403).json({
        success: false,
        message: "این گفتگو در دسترس نیست"
      });
    }

    const q = new URLSearchParams({
      select: "id,conversation_id,sender_id,message_type,message_text,image_path,created_at",
      conversation_id: "eq." + conversationId,
      or: "(expires_at.is.null,expires_at.gt." + new Date().toISOString() + ")",
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
      video_url: m.message_type === "video" ? await arifChatSignedImage(m.image_path) : null,
      audio_url: m.message_type === "audio" ? await arifChatSignedImage(m.image_path) : null,
      created_at: m.created_at
    })));

    return res.json({ success: true, current_user_id: me.id, messages: result });
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

    if (await arifChatIsBlocked(conversation, me.id)) {
      return res.status(403).json({
        success: false,
        message: "ارسال پیام به این کاربر امکان‌پذیر نیست"
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
        message_type: "text",
        message_text: messageText,
        image_path: null,
        expires_at: Number(conversation.disappearing_seconds || 0) > 0
          ? new Date(Date.now() + Number(conversation.disappearing_seconds) * 1000).toISOString()
          : null
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

    if (await arifChatIsBlocked(conversation, me.id)) {
      return res.status(403).json({
        success: false,
        message: "ارسال تصویر به این کاربر امکان‌پذیر نیست"
      });
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
        image_path: imagePath,
        expires_at: Number(conversation.disappearing_seconds || 0) > 0
          ? new Date(Date.now() + Number(conversation.disappearing_seconds) * 1000).toISOString()
          : null
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





app.post("/api/chat/conversations/:id/media/upload-token", async (req, res) => {
  const session = marketSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });
  }

  const conversationId = String(req.params.id || "");
  const mime = String(req.body.mime_type || "").split(";")[0].trim().toLowerCase();
  const size = Number(req.body.file_size);

  const types = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "audio/webm": "webm"
  };

  if (!/^[0-9]+$/.test(conversationId) ||
      !types[mime] ||
      !Number.isSafeInteger(size) ||
      size < 1 || size > 52428800) {
    return res.status(400).json({
      success: false,
      message: "نوع یا حجم فایل معتبر نیست؛ حداکثر ۵۰ مگابایت"
    });
  }

  try {
    const { base, key } = marketConfig();
    const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!publicKey) throw new Error("supabase_publishable_key_missing");

    const me = await marketUser(session.email);
    if (!me) {
      return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });
    }

    const conversation = await arifChatConversation(conversationId, me.id);
    if (!conversation) {
      return res.status(404).json({ success: false, message: "گفت‌وگو پیدا نشد" });
    }

    if (await arifChatIsBlocked(conversation, me.id)) {
      return res.status(403).json({
        success: false,
        message: "ارسال رسانه به این کاربر امکان‌پذیر نیست"
      });
    }

    const path = conversationId + "/" + me.id + "/" +
      marketCrypto.randomUUID() + "." + types[mime];

    const objectPath = path.split("/").map(encodeURIComponent).join("/");
    const signedResponse = await fetch(
      base + "/storage/v1/object/upload/sign/chat-images/" + objectPath,
      {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ upsert: false })
      }
    );

    if (!signedResponse.ok) {
      console.error("ARIF_CHAT_TUS_SIGN_ERROR:", signedResponse.status);
      return res.status(503).json({
        success: false,
        message: "صدور مجوز آپلود ناموفق بود"
      });
    }

    const signedData = await signedResponse.json();
    if (!signedData.token) throw new Error("storage_upload_token_missing");

    let storageBase = base;
    try {
      const u = new URL(base);
      const match = u.hostname.match(/^([^.]+)\.supabase\.co$/i);
      if (match) {
        u.hostname = match[1] + ".storage.supabase.co";
        storageBase = u.origin;
      }
    } catch (_) {}

    return res.json({
      success: true,
      path,
      token: signedData.token,
      tus_endpoint: storageBase + "/storage/v1/upload/resumable",
      api_key: publicKey,
      file_size: size,
      mime_type: mime
    });
  } catch (e) {
    console.error("ARIF_CHAT_TUS_TOKEN_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({
      success: false,
      message: "آماده‌سازی آپلود ناموفق بود"
    });
  }
});

app.post("/api/chat/conversations/:id/media/complete", async (req, res) => {
  const session = marketSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });
  }

  const conversationId = String(req.params.id || "");
  const path = String(req.body.path || "");
  const mime = String(req.body.mime_type || "").split(";")[0].trim().toLowerCase();
  const size = Number(req.body.file_size);

  const types = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "audio/webm": "webm"
  };

  if (!/^[0-9]+$/.test(conversationId) ||
      !types[mime] ||
      !Number.isSafeInteger(size) ||
      size < 1 || size > 52428800) {
    return res.status(400).json({
      success: false,
      message: "اطلاعات رسانه معتبر نیست"
    });
  }

  try {
    const { base, key } = marketConfig();
    const me = await marketUser(session.email);

    if (!me) {
      return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });
    }

    const conversation = await arifChatConversation(conversationId, me.id);
    if (!conversation) {
      return res.status(404).json({ success: false, message: "گفت‌وگو پیدا نشد" });
    }

    if (await arifChatIsBlocked(conversation, me.id)) {
      return res.status(403).json({
        success: false,
        message: "ارسال رسانه به این کاربر امکان‌پذیر نیست"
      });
    }

    const prefix = conversationId + "/" + me.id + "/";
    const filename = path.startsWith(prefix) ? path.slice(prefix.length) : "";

    if (!/^[0-9a-f-]{36}\.(jpg|png|webp|mp4|mov|webm)$/i.test(filename) ||
        !filename.toLowerCase().endsWith("." + types[mime])) {
      return res.status(400).json({
        success: false,
        message: "مسیر فایل معتبر نیست"
      });
    }

    const parent = path.slice(0, path.lastIndexOf("/") + 1);
    const name = path.slice(path.lastIndexOf("/") + 1);

    const listResponse = await fetch(
      base + "/storage/v1/object/list/chat-images",
      {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prefix: parent,
          search: name,
          limit: 100
        })
      }
    );

    if (!listResponse.ok) {
      throw new Error("chat_media_storage_check_failed");
    }

    const objects = await listResponse.json();
    const object = Array.isArray(objects)
      ? objects.find(item => item.name === name)
      : null;

    const actualSize = object && object.metadata
      ? Number(object.metadata.size)
      : NaN;

    if (!object ||
        !Number.isSafeInteger(actualSize) ||
        actualSize !== size ||
        actualSize > 52428800) {
      return res.status(400).json({
        success: false,
        message: "فایل آپلودشده تأیید نشد یا حجم آن مطابقت ندارد"
      });
    }

    const messageType = mime.startsWith("audio/") ? "audio" :
      mime.startsWith("video/") ? "video" : "image";
    const disappearingSeconds = Number(conversation.disappearing_seconds || 0);

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
        message_type: messageType,
        message_text: null,
        image_path: path,
        expires_at: disappearingSeconds > 0
          ? new Date(Date.now() + disappearingSeconds * 1000).toISOString()
          : null
      })
    });

    if (!r.ok) {
      const objectPath = path.split("/").map(encodeURIComponent).join("/");

      await fetch(
        base + "/storage/v1/object/chat-images/" + objectPath,
        {
          method: "DELETE",
          headers: {
            apikey: key,
            Authorization: "Bearer " + key
          }
        }
      ).catch(() => {});

      console.error(
        "ARIF_CHAT_MEDIA_DB_ERROR:",
        r.status,
        (await r.text()).slice(0, 200)
      );

      return res.status(503).json({
        success: false,
        message: "ثبت رسانه در گفت‌وگو ناموفق بود"
      });
    }

    await fetch(
      base + "/rest/v1/chat_conversations?id=eq." +
        encodeURIComponent(conversationId),
      {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          last_message_at: new Date().toISOString()
        })
      }
    );

    const rows = await r.json();
    const message = Array.isArray(rows) ? rows[0] : null;
    const signedUrl = await arifChatSignedImage(path);

    return res.status(201).json({
      success: true,
      message: message ? {
        id: message.id,
        conversation_id: message.conversation_id,
        sender_id: message.sender_id,
        message_type: messageType,
        image_url: messageType === "image" ? signedUrl : null,
        video_url: messageType === "video" ? signedUrl : null,
        audio_url: messageType === "audio" ? signedUrl : null,
        created_at: message.created_at
      } : null
    });
  } catch (e) {
    console.error(
      "ARIF_CHAT_MEDIA_COMPLETE_ERROR:",
      String(e.message || e).slice(0, 150)
    );

    return res.status(503).json({
      success: false,
      message: "ثبت رسانه ناموفق بود"
    });
  }
});


/* ARIF_CHAT_REPORT_API_V1 */
app.post("/api/chat/conversations/:id/report", async (req, res) => {
  const session = marketSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });
  }

  const conversationId = String(req.params.id || "");
  if (!/^[0-9]+$/.test(conversationId)) {
    return res.status(400).json({ success: false, message: "شناسه گفت‌وگو معتبر نیست" });
  }

  const allowedReasons = [
    "spam",
    "harassment",
    "scam",
    "inappropriate_content",
    "impersonation",
    "other"
  ];

  const reason = String(req.body?.reason || "").trim();
  if (!allowedReasons.includes(reason)) {
    return res.status(400).json({ success: false, message: "دلیل گزارش معتبر نیست" });
  }

  const detailsValue = req.body?.details;
  if (detailsValue != null && typeof detailsValue !== "string") {
    return res.status(400).json({ success: false, message: "توضیحات گزارش معتبر نیست" });
  }

  const details = String(detailsValue || "").trim();
  if (details.length > 1000) {
    return res.status(400).json({ success: false, message: "توضیحات حداکثر ۱۰۰۰ نویسه باشد" });
  }

  try {
    const { base, key } = marketConfig();
    const me = await marketUser(session.email);
    if (!me) {
      return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });
    }

    const conversation = await arifChatConversation(conversationId, me.id);
    if (!conversation) {
      return res.status(404).json({ success: false, message: "گفت‌وگو پیدا نشد" });
    }

    const otherId = arifChatOtherUserId(conversation, me.id);
    if (!otherId) {
      return res.status(404).json({ success: false, message: "کاربر گفتگو پیدا نشد" });
    }

    const r = await fetch(base + "/rest/v1/chat_reports", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        reporter_id: me.id,
        reported_user_id: otherId,
        conversation_id: conversation.id,
        reason,
        details: details || null
      })
    });

    if (!r.ok) {
      console.error("ARIF_CHAT_REPORT_ERROR:", r.status);
      return res.status(503).json({ success: false, message: "ثبت گزارش انجام نشد" });
    }

    return res.status(201).json({ success: true, message: "گزارش ثبت شد" });
  } catch (e) {
    console.error("ARIF_CHAT_REPORT_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "ثبت گزارش ناموفق بود" });
  }
});
/* END ARIF_CHAT_REPORT_API_V1 */



/* ARIF_CHAT_BLOCK_API_V1 */

app.post("/api/chat/conversations/:id/block", async (req, res) => {
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

    const otherId = arifChatOtherUserId(conversation, me.id);
    if (!otherId) return res.status(404).json({ success: false, message: "کاربر گفتگو پیدا نشد" });

    const url = new URLSearchParams({
      on_conflict: "blocker_id,blocked_user_id"
    });

    const r = await fetch(base + "/rest/v1/chat_blocks?" + url, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal"
      },
      body: JSON.stringify({
        blocker_id: me.id,
        blocked_user_id: otherId
      })
    });

    if (!r.ok) {
      console.error("ARIF_CHAT_BLOCK_ERROR:", r.status);
      return res.status(503).json({ success: false, message: "مسدودسازی انجام نشد" });
    }

    return res.json({ success: true, blocked: true });
  } catch (e) {
    console.error("ARIF_CHAT_BLOCK_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "مسدودسازی ناموفق بود" });
  }
});

app.delete("/api/chat/conversations/:id/block", async (req, res) => {
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

    const otherId = arifChatOtherUserId(conversation, me.id);
    if (!otherId) return res.status(404).json({ success: false, message: "کاربر گفتگو پیدا نشد" });

    const q = new URLSearchParams({
      blocker_id: "eq." + me.id,
      blocked_user_id: "eq." + otherId
    });

    const r = await fetch(base + "/rest/v1/chat_blocks?" + q, {
      method: "DELETE",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        Prefer: "return=minimal"
      }
    });

    if (!r.ok) {
      console.error("ARIF_CHAT_UNBLOCK_ERROR:", r.status);
      return res.status(503).json({ success: false, message: "رفع مسدودسازی انجام نشد" });
    }

    return res.json({ success: true, blocked: false });
  } catch (e) {
    console.error("ARIF_CHAT_UNBLOCK_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "رفع مسدودسازی ناموفق بود" });
  }
});

app.get("/api/chat/conversations/:id/block-status", async (req, res) => {
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

    const otherId = arifChatOtherUserId(conversation, me.id);
    if (!otherId) return res.status(404).json({ success: false, message: "کاربر گفتگو پیدا نشد" });

    const q = new URLSearchParams({
      select: "id",
      blocker_id: "eq." + me.id,
      blocked_user_id: "eq." + otherId,
      limit: "1"
    });

    const r = await fetch(base + "/rest/v1/chat_blocks?" + q, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });

    if (!r.ok) {
      console.error("ARIF_CHAT_BLOCK_STATUS_ERROR:", r.status);
      return res.status(503).json({ success: false, message: "بررسی وضعیت انجام نشد" });
    }

    const rows = await r.json();
    return res.json({ success: true, blocked: Array.isArray(rows) && rows.length > 0 });
  } catch (e) {
    console.error("ARIF_CHAT_BLOCK_STATUS_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "بررسی وضعیت ناموفق بود" });
  }
});

/* END ARIF_CHAT_BLOCK_API_V1 */


/* ARIF_CHAT_DISAPPEARING_API_V1 */

app.get("/api/chat/conversations/:id/disappearing", async (req, res) => {
  const session = marketSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });
  }

  const conversationId = String(req.params.id || "");
  if (!/^[0-9]+$/.test(conversationId)) {
    return res.status(400).json({ success: false, message: "شناسه گفت‌وگو معتبر نیست" });
  }

  try {
    const me = await marketUser(session.email);
    if (!me) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const conversation = await arifChatConversation(conversationId, me.id);
    if (!conversation) {
      return res.status(404).json({ success: false, message: "گفت‌وگو پیدا نشد" });
    }

    return res.json({
      success: true,
      seconds: Number(conversation.disappearing_seconds || 0)
    });
  } catch (e) {
    console.error("ARIF_CHAT_DISAPPEARING_READ_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "خواندن تنظیم ناموفق بود" });
  }
});

app.patch("/api/chat/conversations/:id/disappearing", async (req, res) => {
  const session = marketSession(req);
  if (!session) {
    return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });
  }

  const conversationId = String(req.params.id || "");
  if (!/^[0-9]+$/.test(conversationId)) {
    return res.status(400).json({ success: false, message: "شناسه گفت‌وگو معتبر نیست" });
  }

  const seconds = Number(req.body && req.body.seconds);
  if (![0, 36000, 86400].includes(seconds)) {
    return res.status(400).json({ success: false, message: "مدت زمان انتخاب‌شده معتبر نیست" });
  }

  try {
    const { base, key } = marketConfig();
    const me = await marketUser(session.email);
    if (!me) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const conversation = await arifChatConversation(conversationId, me.id);
    if (!conversation) {
      return res.status(404).json({ success: false, message: "گفت‌وگو پیدا نشد" });
    }

    const q = new URLSearchParams({ id: "eq." + conversationId });
    const r = await fetch(base + "/rest/v1/chat_conversations?" + q, {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({ disappearing_seconds: seconds })
    });

    if (!r.ok) {
      console.error("ARIF_CHAT_DISAPPEARING_UPDATE_ERROR:", r.status);
      return res.status(503).json({ success: false, message: "ذخیره تنظیم ناموفق بود" });
    }

    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(404).json({ success: false, message: "گفت‌وگو پیدا نشد" });
    }

    return res.json({ success: true, seconds: Number(rows[0].disappearing_seconds || 0) });
  } catch (e) {
    console.error("ARIF_CHAT_DISAPPEARING_UPDATE_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "ذخیره تنظیم ناموفق بود" });
  }
});

/* END ARIF_CHAT_DISAPPEARING_API_V1 */


/* ARIF_CHAT_PRESENCE_API_V1 */

app.post("/api/chat/presence/heartbeat", async (req, res) => {
  const session = marketSession(req);
  if (!session) return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });

  try {
    const { base, key } = marketConfig();
    const me = await marketUser(session.email);
    if (!me) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const now = new Date().toISOString();
    const q = new URLSearchParams({ on_conflict: "user_id" });
    const r = await fetch(base + "/rest/v1/chat_presence?" + q, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        user_id: me.id,
        last_seen_at: now,
        updated_at: now
      })
    });

    if (!r.ok) {
      console.error("ARIF_CHAT_PRESENCE_HEARTBEAT_ERROR:", r.status, (await r.text()).slice(0, 160));
      return res.status(503).json({ success: false, message: "ثبت وضعیت حضور ناموفق بود" });
    }

    return res.json({ success: true });
  } catch (e) {
    console.error("ARIF_CHAT_PRESENCE_HEARTBEAT_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "ثبت وضعیت حضور ناموفق بود" });
  }
});

app.get("/api/chat/privacy/last-seen", async (req, res) => {
  const session = marketSession(req);
  if (!session) return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });

  try {
    const { base, key } = marketConfig();
    const me = await marketUser(session.email);
    if (!me) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const q = new URLSearchParams({
      select: "last_seen_visibility",
      user_id: "eq." + me.id,
      limit: "1"
    });
    const r = await fetch(base + "/rest/v1/chat_user_privacy?" + q, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });

    if (!r.ok) {
      console.error("ARIF_CHAT_PRIVACY_READ_ERROR:", r.status);
      return res.status(503).json({ success: false, message: "خواندن حریم خصوصی ناموفق بود" });
    }

    const rows = await r.json();
    const visibility = Array.isArray(rows) && rows.length
      ? rows[0].last_seen_visibility
      : "everyone";

    return res.json({
      success: true,
      visibility: ["everyone", "nobody"].includes(visibility) ? visibility : "everyone"
    });
  } catch (e) {
    console.error("ARIF_CHAT_PRIVACY_READ_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "خواندن حریم خصوصی ناموفق بود" });
  }
});

app.patch("/api/chat/privacy/last-seen", async (req, res) => {
  const session = marketSession(req);
  if (!session) return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });

  const visibility = String(req.body && req.body.visibility || "");
  if (!["everyone", "nobody"].includes(visibility)) {
    return res.status(400).json({ success: false, message: "تنظیم حریم خصوصی معتبر نیست" });
  }

  try {
    const { base, key } = marketConfig();
    const me = await marketUser(session.email);
    if (!me) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const q = new URLSearchParams({ on_conflict: "user_id" });
    const r = await fetch(base + "/rest/v1/chat_user_privacy?" + q, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        user_id: me.id,
        last_seen_visibility: visibility,
        updated_at: new Date().toISOString()
      })
    });

    if (!r.ok) {
      console.error("ARIF_CHAT_PRIVACY_UPDATE_ERROR:", r.status, (await r.text()).slice(0, 160));
      return res.status(503).json({ success: false, message: "ذخیره حریم خصوصی ناموفق بود" });
    }

    return res.json({ success: true, visibility });
  } catch (e) {
    console.error("ARIF_CHAT_PRIVACY_UPDATE_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "ذخیره حریم خصوصی ناموفق بود" });
  }
});


app.post("/api/chat/presence/leave", async (req, res) => {
  const session = marketSession(req);
  if (!session) return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });

  try {
    const { base, key } = marketConfig();
    const me = await marketUser(session.email);
    if (!me) return res.status(404).json({ success: false, message: "حساب کاربری پیدا نشد" });

    const now = new Date();
    const lastSeen = now.toISOString();
    const offlineAt = new Date(now.getTime() - 120000).toISOString();

    const q = new URLSearchParams({ on_conflict: "user_id" });
    const r = await fetch(base + "/rest/v1/chat_presence?" + q, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        user_id: me.id,
        last_seen_at: lastSeen,
        updated_at: offlineAt
      })
    });

    if (!r.ok) {
      console.error("ARIF_CHAT_PRESENCE_LEAVE_ERROR:", r.status, (await r.text()).slice(0, 160));
      return res.status(503).json({ success: false, message: "ثبت خروج ناموفق بود" });
    }

    return res.json({ success: true, last_seen_at: lastSeen });
  } catch (e) {
    console.error("ARIF_CHAT_PRESENCE_LEAVE_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "ثبت خروج ناموفق بود" });
  }
});

app.get("/api/chat/conversations/:id/presence", async (req, res) => {
  const session = marketSession(req);
  if (!session) return res.status(401).json({ success: false, message: "ابتدا وارد حساب شوید" });

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

    if (await arifChatIsBlocked(conversation, me.id)) {
      return res.json({ success: true, visible: false, online: false, last_seen_at: null });
    }

    const otherId = arifChatOtherUserId(conversation, me.id);
    if (!otherId) {
      return res.status(404).json({ success: false, message: "مخاطب گفت‌وگو پیدا نشد" });
    }

    const privacyQ = new URLSearchParams({
      select: "last_seen_visibility",
      user_id: "eq." + otherId,
      limit: "1"
    });
    const presenceQ = new URLSearchParams({
      select: "last_seen_at,updated_at",
      user_id: "eq." + otherId,
      limit: "1"
    });

    const [privacyR, presenceR] = await Promise.all([
      fetch(base + "/rest/v1/chat_user_privacy?" + privacyQ, {
        headers: { apikey: key, Authorization: "Bearer " + key }
      }),
      fetch(base + "/rest/v1/chat_presence?" + presenceQ, {
        headers: { apikey: key, Authorization: "Bearer " + key }
      })
    ]);

    if (!privacyR.ok || !presenceR.ok) {
      console.error("ARIF_CHAT_PRESENCE_READ_ERROR:", privacyR.status, presenceR.status);
      return res.status(503).json({ success: false, message: "دریافت وضعیت مخاطب ناموفق بود" });
    }

    const privacyRows = await privacyR.json();
    const presenceRows = await presenceR.json();
    const visibility = Array.isArray(privacyRows) && privacyRows.length
      ? privacyRows[0].last_seen_visibility
      : "everyone";

    if (visibility !== "everyone") {
      return res.json({ success: true, visible: false, online: false, last_seen_at: null });
    }

    const presence = Array.isArray(presenceRows) && presenceRows.length
      ? presenceRows[0]
      : null;

    const updatedAt = presence && presence.updated_at
      ? new Date(presence.updated_at).getTime()
      : 0;
    const online = Number.isFinite(updatedAt) &&
      updatedAt > 0 &&
      Date.now() - updatedAt <= 60000;

    return res.json({
      success: true,
      visible: true,
      online,
      last_seen_at: online ? null : (presence ? presence.last_seen_at : null)
    });
  } catch (e) {
    console.error("ARIF_CHAT_PRESENCE_READ_ERROR:", String(e.message || e).slice(0, 150));
    return res.status(503).json({ success: false, message: "دریافت وضعیت مخاطب ناموفق بود" });
  }
});

/* END ARIF_CHAT_PRESENCE_API_V1 */



require("./otp")(app);
require("./sms-otp")(app);
require("./password-auth")(app);
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

/* ADMIN_CHAT_VIEW_API */
app.get("/admin/api/chat/conversations", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!adminAuth.isAdmin(req)) {
    return res.status(401).json({ success: false, message: "دسترسی مدیر لازم است" });
  }

  try {
    const { base, key } = marketConfig();
    const q = new URLSearchParams({
      select: "id,user_one_id,user_two_id,created_at,last_message_at",
      order: "last_message_at.desc.nullslast",
      limit: "100"
    });
    const r = await fetch(base + "/rest/v1/chat_conversations?" + q, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!r.ok) throw new Error("chat_conversations_read_failed");

    const conversations = await r.json();
    const rows = Array.isArray(conversations) ? conversations : [];
    const ids = [...new Set(rows.flatMap(c => [
      String(c.user_one_id), String(c.user_two_id)
    ]).filter(x => /^[0-9]+$/.test(x)))];

    let users = [];
    if (ids.length) {
      const uq = new URLSearchParams({
        select: "id,email",
        id: "in.(" + ids.join(",") + ")"
      });
      const ur = await fetch(base + "/rest/v1/app_users?" + uq, {
        headers: { apikey: key, Authorization: "Bearer " + key }
      });
      if (!ur.ok) throw new Error("chat_users_read_failed");
      users = await ur.json();
    }

    const emailById = new Map((Array.isArray(users) ? users : [])
      .map(u => [String(u.id), String(u.email || "")]));

    return res.json({
      success: true,
      conversations: rows.map(c => ({
        id: c.id,
        user_one_id: c.user_one_id,
        user_two_id: c.user_two_id,
        user_one_email: emailById.get(String(c.user_one_id)) || "",
        user_two_email: emailById.get(String(c.user_two_id)) || "",
        created_at: c.created_at,
        last_message_at: c.last_message_at
      }))
    });
  } catch (e) {
    console.error("ADMIN_CHAT_LIST_ERROR:", String(e.message || e).slice(0, 120));
    return res.status(503).json({
      success: false, message: "دریافت فهرست گفت‌وگوها ناموفق بود"
    });
  }
});

app.get("/admin/api/chat/conversations/:id/messages", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!adminAuth.isAdmin(req)) {
    return res.status(401).json({ success: false, message: "دسترسی مدیر لازم است" });
  }

  const conversationId = String(req.params.id || "");
  if (!/^[0-9]+$/.test(conversationId)) {
    return res.status(400).json({ success: false, message: "شناسه گفت‌وگو معتبر نیست" });
  }

  try {
    const { base, key } = marketConfig();
    const cq = new URLSearchParams({
      select: "id,user_one_id,user_two_id",
      id: "eq." + conversationId,
      limit: "1"
    });
    const cr = await fetch(base + "/rest/v1/chat_conversations?" + cq, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!cr.ok) throw new Error("chat_conversation_lookup_failed");
    const conversations = await cr.json();
    if (!Array.isArray(conversations) || !conversations.length) {
      return res.status(404).json({ success: false, message: "گفت‌وگو پیدا نشد" });
    }

    const mq = new URLSearchParams({
      select: "id,conversation_id,sender_id,message_type,message_text,image_path,created_at",
      conversation_id: "eq." + conversationId,
      order: "created_at.asc",
      limit: "500"
    });
    const mr = await fetch(base + "/rest/v1/chat_messages?" + mq, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!mr.ok) throw new Error("chat_messages_read_failed");

    const messages = await mr.json();
    const rows = Array.isArray(messages) ? messages : [];
    const senderIds = [...new Set(rows.map(m => String(m.sender_id))
      .filter(x => /^[0-9]+$/.test(x)))];

    let users = [];
    if (senderIds.length) {
      const uq = new URLSearchParams({
        select: "id,email",
        id: "in.(" + senderIds.join(",") + ")"
      });
      const ur = await fetch(base + "/rest/v1/app_users?" + uq, {
        headers: { apikey: key, Authorization: "Bearer " + key }
      });
      if (!ur.ok) throw new Error("chat_users_read_failed");
      users = await ur.json();
    }

    const emailById = new Map((Array.isArray(users) ? users : [])
      .map(u => [String(u.id), String(u.email || "")]));

    const result = await Promise.all(rows.map(async m => ({
      id: m.id,
      sender_id: m.sender_id,
      sender_email: emailById.get(String(m.sender_id)) || "",
      message_type: m.message_type,
      message_text: m.message_text,
      image_url: m.message_type === "image"
        ? await arifChatSignedImage(m.image_path) : null,
      created_at: m.created_at
    })));

    return res.json({ success: true, messages: result });
  } catch (e) {
    console.error("ADMIN_CHAT_MESSAGES_ERROR:", String(e.message || e).slice(0, 120));
    return res.status(503).json({
      success: false, message: "دریافت پیام‌ها ناموفق بود"
    });
  }
});
/* END ADMIN_CHAT_VIEW_API */


/* ARIF_CHAT_EXPIRY_CLEANUP_V1 */
let arifChatExpiryCleanupRunning = false;

async function arifCleanupExpiredChatMessages() {
  if (arifChatExpiryCleanupRunning) return;
  arifChatExpiryCleanupRunning = true;

  try {
    const { base, key } = marketConfig();
    const now = new Date().toISOString();

    const q = new URLSearchParams({
      select: "id,message_type,image_path,expires_at",
      expires_at: "lt." + now,
      order: "expires_at.asc",
      limit: "100"
    });

    const response = await fetch(
      base + "/rest/v1/chat_messages?" + q,
      {
        headers: {
          apikey: key,
          Authorization: "Bearer " + key
        }
      }
    );

    if (!response.ok) {
      throw new Error("expired_messages_read_failed_" + response.status);
    }

    const messages = await response.json();
    let deleted = 0;
    let skipped = 0;

    for (const message of (Array.isArray(messages) ? messages : [])) {
      try {
        if (message.image_path) {
          const objectPath = String(message.image_path)
            .split("/")
            .map(encodeURIComponent)
            .join("/");

          const storageDelete = await fetch(
            base + "/storage/v1/object/chat-images/" + objectPath,
            {
              method: "DELETE",
              headers: {
                apikey: key,
                Authorization: "Bearer " + key
              }
            }
          );

          if (!storageDelete.ok && storageDelete.status !== 404) {
            skipped++;
            console.error(
              "ARIF_CHAT_EXPIRY_STORAGE_ERROR:",
              storageDelete.status
            );
            continue;
          }
        }

        const deleteQuery = new URLSearchParams({
          id: "eq." + String(message.id),
          expires_at: "lt." + now,
          select: "id"
        });

        const dbDelete = await fetch(
          base + "/rest/v1/chat_messages?" + deleteQuery,
          {
            method: "DELETE",
            headers: {
              apikey: key,
              Authorization: "Bearer " + key,
              Prefer: "return=representation"
            }
          }
        );

        if (!dbDelete.ok) {
          skipped++;
          console.error(
            "ARIF_CHAT_EXPIRY_DB_DELETE_ERROR:",
            dbDelete.status
          );
          continue;
        }

        const deletedRows = await dbDelete.json();
        if (Array.isArray(deletedRows) && deletedRows.length) {
          deleted += deletedRows.length;
        }
      } catch (itemError) {
        skipped++;
        console.error(
          "ARIF_CHAT_EXPIRY_ITEM_ERROR:",
          String(itemError.message || itemError).slice(0, 120)
        );
      }
    }

    if (deleted || skipped) {
      console.log(
        "ARIF_CHAT_EXPIRY_CLEANUP:",
        "deleted=" + deleted,
        "skipped=" + skipped
      );
    }
  } catch (error) {
    console.error(
      "ARIF_CHAT_EXPIRY_CLEANUP_ERROR:",
      String(error.message || error).slice(0, 150)
    );
  } finally {
    arifChatExpiryCleanupRunning = false;
  }
}
/* END ARIF_CHAT_EXPIRY_CLEANUP_V1 */

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Arif App Backend running on port ${PORT}`);

  void arifCleanupExpiredChatMessages();

  setInterval(() => {
    void arifCleanupExpiredChatMessages();
  }, 5 * 60 * 1000);
});
