const express = require("express");

const app = express();
app.use(express.json());

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

app.get("/admin", (req, res) => {
  const auth = req.headers.authorization || "";
  const expected = "Basic " + Buffer.from(
    (process.env.ADMIN_USER || "admin") + ":" + (process.env.ADMIN_PASSWORD || "change-me")
  ).toString("base64");

  if (auth !== expected) {
    res.set("WWW-Authenticate", "Basic realm=\"Arif App Admin\"");
    return res.status(401).send("دسترسی غیرمجاز");
  }

  const rows = orders.map(order => `
    <tr>
      <td>${order.id}</td>
      <td>${order.product}</td>
      <td>${order.price}</td>
      <td>${order.playerId}</td>
      <td>${order.tracking}</td>
      <td>${order.status}</td>
      <td>${order.createdAt}</td>
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
</style>
</head>
<body>
<h1>پنل مدیریت Arif App</h1>
<p>تعداد سفارش‌ها: ${orders.length}</p>
<table>
<tr><th>شماره</th><th>محصول</th><th>قیمت</th><th>Player ID</th><th>پیگیری</th><th>وضعیت</th><th>تاریخ</th></tr>
${rows}
</table>
</body>
</html>`);
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Arif App Backend running on port ${PORT}`);
});
