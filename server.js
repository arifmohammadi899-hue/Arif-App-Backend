const express = require("express");

const app = express();
app.use(express.json());

const fs = require("fs");
const ORDERS_FILE = "./orders.json";
const orders = fs.existsSync(ORDERS_FILE) ? JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8")) : [];
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

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Arif App Backend running on port ${PORT}`);
});
