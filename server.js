require("dotenv").config();
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
  const expected = "Basic " + Buffer.from(
    (process.env.ADMIN_USER || "admin") + ":" + (process.env.ADMIN_PASSWORD || "change-me")
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
  const expected = "Basic " + Buffer.from(
    (process.env.ADMIN_USER || "admin") + ":" + (process.env.ADMIN_PASSWORD || "change-me")
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
