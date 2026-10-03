const express = require("express");

const app = express();
app.use(express.json());

const orders = [];
let nextOrderId = 1001;

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

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Arif App Backend running on port ${PORT}`);
});
