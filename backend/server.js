
import express from "express";
import cors from "cors";
import helmet from "helmet";
import pg from "pg";
import { randomUUID, timingSafeEqual } from "node:crypto";

const { Pool } = pg;
const app = express();

app.disable("x-powered-by");
app.use(helmet());

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origem não autorizada"));
  }
}));

app.use(express.json({ limit: "100kb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  max: 5
});

const AMPLOPAY_URL =
  "https://app.amplopay.com/api/v1/gateway/pix/receive";

// ======================================
// UTILITÁRIOS
// ======================================

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function safeEqual(a, b) {
  if (!a || !b) return false;

  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  return first.length === second.length &&
    timingSafeEqual(first, second);
}

function mapProduct(row) {
  return {
    id: row.id,
    name: row.name,
    gatewayName: row.gateway_name,
    description: row.description,
    price: Number(row.price),
    imageUrl: row.image_url,
    kind: row.kind,
    unit: row.unit,
    active: row.active
  };
}

function mapOrder(row) {
  return {
    id: row.id,
    qrCodeText: row.pix_code || "",
    qrCodeBase64: row.pix_image || "",
    amount: Number(row.amount),
    status: row.status
  };
}

function getGatewayCredentials() {
  const publicKey = process.env.AMPLOPAY_PUBLIC_KEY;
  const secretKey = process.env.AMPLOPAY_SECRET_KEY;

  if (!publicKey || !secretKey) {
    const error = new Error("AmploPay não configurada");
    error.status = 503;
    throw error;
  }

  return {
    "x-public-key": publicKey,
    "x-secret-key": secretKey,
    "Content-Type": "application/json",
    Accept: "application/json"
  };
}

async function consultarSearchAPI(cpf) {
  const baseUrl = process.env.SEARCHAPI_BASE_URL;
  const token = process.env.SEARCHAPI_TOKEN_API;

  if (!baseUrl || !token) {
    const error = new Error("SearchAPI não configurada na Railway");
    error.code = "NOT_CONFIGURED";
    throw error;
  }

  const url = new URL(baseUrl);
  url.searchParams.set("cpf", cpf);
  url.searchParams.set("token_api", token);

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20000)
  });

  const responseText = await response.text();

  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    const error = new Error("A SearchAPI não retornou JSON válido");
    error.code = "INVALID_RESPONSE";
    throw error;
  }

  if (!response.ok) {
    const error = new Error("A SearchAPI retornou erro HTTP");
    error.code = "PROVIDER_ERROR";
    error.providerStatus = response.status;
    throw error;
  }

  return result;
}

function extrairRegistro(result) {
  const dados = result?.dados;

  if (Array.isArray(dados)) return dados[0] || null;
  if (dados && typeof dados === "object") return dados;

  return null;
}

function formatarRegistro(registro, cpf) {
  return {
    cpf: registro.CPF || cpf,
    name: registro.NOME || "",
    birthDate: registro.NASC || "",
    motherName: registro.NOME_MAE || "",
    gender: registro.GENERO || registro.SEXO || ""
  };
}

// ======================================
// HEALTH CHECK
// ======================================

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "online",
    service: "ecred-api",
    timestamp: new Date().toISOString()
  });
});

app.get("/health/db", async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({
      status: "error",
      message: "DATABASE_URL não configurada"
    });
  }

  try {
    const result = await pool.query("SELECT NOW() AS database_time");

    return res.status(200).json({
      status: "connected",
      database: "PostgreSQL",
      timestamp: result.rows[0].database_time
    });
  } catch (error) {
    console.error("Erro PostgreSQL:", error.message);

    return res.status(503).json({
      status: "error",
      message: "Falha na conexão com PostgreSQL"
    });
  }
});

// ======================================
// CPF TEST - PAINEL ADMINISTRATIVO
// ======================================

app.post("/api/cpf-test", async (req, res) => {
  const startedAt = Date.now();

  try {
    const cpf = String(req.body?.cpf || "").replace(/\D/g, "");

    if (cpf.length !== 11) {
      return res.status(400).json({
        configured: true,
        ok: false,
        status: 400,
        elapsedMs: Date.now() - startedAt,
        error: "CPF inválido"
      });
    }

    const result = await consultarSearchAPI(cpf);
    const registro = extrairRegistro(result);

    if (!registro) {
      return res.status(200).json({
        configured: true,
        ok: false,
        status: 200,
        elapsedMs: Date.now() - startedAt,
        error: result?.status || "Nenhum registro encontrado"
      });
    }

    const data = formatarRegistro(registro, cpf);

    return res.status(200).json({
      configured: true,
      ok: Boolean(data.name),
      status: 200,
      elapsedMs: Date.now() - startedAt,
      data,
      error: data.name ? null : "Nome não encontrado"
    });
  } catch (error) {
    console.error("Erro CPF TEST:", error.code || error.message);

    return res.status(200).json({
      configured: error.code !== "NOT_CONFIGURED",
      ok: false,
      status: error.providerStatus || 0,
      elapsedMs: Date.now() - startedAt,
      error: error.message
    });
  }
});

// ======================================
// CPF LOOKUP - CHECKOUT
// ======================================

app.post("/api/cpf-lookup", async (req, res) => {
  try {
    const cpf = String(req.body?.cpf || "").replace(/\D/g, "");

    if (cpf.length !== 11) {
      return res.status(400).json({
        configured: true,
        ok: false,
        error: "CPF inválido"
      });
    }

    const result = await consultarSearchAPI(cpf);
    const registro = extrairRegistro(result);

    if (!registro) {
      return res.status(200).json({
        configured: true,
        ok: false,
        error: result?.status || "Nenhum registro encontrado"
      });
    }

    const dados = formatarRegistro(registro, cpf);

    if (!dados.name) {
      return res.status(200).json({
        configured: true,
        ok: false,
        error: "Nome não encontrado na resposta da SearchAPI"
      });
    }

    return res.status(200).json({
      configured: true,
      ok: true,
      name: dados.name,
      birthDate: dados.birthDate,
      motherName: dados.motherName,
      gender: dados.gender
    });
  } catch (error) {
    console.error("Erro CPF LOOKUP:", error.code || error.message);

    return res.status(502).json({
      configured: error.code !== "NOT_CONFIGURED",
      ok: false,
      error: error.message
    });
  }
});

// ======================================
// AUTORIZAÇÃO PARA ALTERAR PRODUTOS
// ======================================

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_API_TOKEN;

  if (!expected) {
    return res.status(503).json({
      error: "ADMIN_API_TOKEN não configurado"
    });
  }

  const authorization = req.headers.authorization || "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  const supplied = req.headers["x-admin-token"] || bearer;

  if (!safeEqual(supplied, expected)) {
    return res.status(401).json({
      error: "Não autorizado"
    });
  }

  next();
}

// ======================================
// PRODUTOS
// ======================================

app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM products
       WHERE active = TRUE
       ORDER BY created_at ASC`
    );

    return res.json(result.rows.map(mapProduct));
  } catch (error) {
    console.error("Erro ao listar produtos:", error.message);
    return res.status(500).json({ error: "Erro ao listar produtos" });
  }
});

app.post("/api/products", requireAdmin, async (req, res) => {
  try {
    const data = req.body?.data || req.body || {};

    const name = String(data.name || "").trim();
    const price = money(data.price);

    if (!name || price <= 0) {
      return res.status(400).json({
        error: "Nome e preço válido são obrigatórios"
      });
    }

    const id = randomUUID();

    const result = await pool.query(
      `INSERT INTO products
       (id, name, gateway_name, description, price, image_url, kind, unit, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
       RETURNING *`,
      [
        id,
        name,
        String(data.gatewayName || name),
        String(data.description || ""),
        price,
        String(data.imageUrl || ""),
        data.kind === "order_bump" ? "order_bump" : "product",
        data.unit === "PERCENT" ? "PERCENT" : "BRL"
      ]
    );

    return res.status(201).json(mapProduct(result.rows[0]));
  } catch (error) {
    console.error("Erro ao criar produto:", error.message);
    return res.status(500).json({ error: "Erro ao criar produto" });
  }
});

app.patch("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const data = req.body?.data || req.body || {};

    const result = await pool.query(
      `UPDATE products SET
        name = COALESCE($2, name),
        gateway_name = COALESCE($3, gateway_name),
        description = COALESCE($4, description),
        price = COALESCE($5, price),
        image_url = COALESCE($6, image_url),
        updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        req.params.id,
        data.name !== undefined ? String(data.name).trim() : null,
        data.gatewayName !== undefined ? String(data.gatewayName) : null,
        data.description !== undefined ? String(data.description) : null,
        data.price !== undefined ? money(data.price) : null,
        data.imageUrl !== undefined ? String(data.imageUrl) : null
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Produto não encontrado" });
    }

    return res.json(mapProduct(result.rows[0]));
  } catch (error) {
    console.error("Erro ao atualizar produto:", error.message);
    return res.status(500).json({ error: "Erro ao atualizar produto" });
  }
});

app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE products
       SET active = FALSE, updated_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Produto não encontrado" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("Erro ao remover produto:", error.message);
    return res.status(500).json({ error: "Erro ao remover produto" });
  }
});

// ======================================
// CRIAR PEDIDO E PIX AMPLOPAY
// ======================================

app.post("/api/orders", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      attemptId,
      visitorId,
      productId,
      bumpIds = [],
      name,
      cpf,
      phone,
      email
    } = req.body || {};

    if (!attemptId || !productId || !name || !email) {
      return res.status(400).json({
        error: "Dados obrigatórios do pedido não informados"
      });
    }

    // Evita criar duas cobranças para a mesma tentativa.
    const existing = await pool.query(
      "SELECT * FROM orders WHERE attempt_id = $1 LIMIT 1",
      [String(attemptId)]
    );

    if (existing.rowCount) {
      return res.json({
        configured: true,
        order: mapOrder(existing.rows[0])
      });
    }

    const ids = [
      String(productId),
      ...Array.isArray(bumpIds) ? bumpIds.map(String) : []
    ];

    const productsResult = await pool.query(
      `SELECT * FROM products
       WHERE id = ANY($1::text[]) AND active = TRUE`,
      [ids]
    );

    const productsById = new Map(
      productsResult.rows.map(product => [product.id, product])
    );

    const mainProduct = productsById.get(String(productId));

    if (!mainProduct) {
      return res.status(400).json({
        error: "Produto principal não encontrado ou inativo"
      });
    }

    const selectedBumps = [...new Set(
      (Array.isArray(bumpIds) ? bumpIds : []).map(String)
    )].map(id => productsById.get(id)).filter(Boolean)
      .filter(product => product.kind === "order_bump");

    const selectedProducts = [mainProduct, ...selectedBumps];

    const amount = money(
      selectedProducts.reduce(
        (total, product) => total + Number(product.price),
        0
      )
    );

    if (amount < 0.01) {
      return res.status(400).json({ error: "Valor do pedido inválido" });
    }

    const orderId = randomUUID();

    const callbackUrl = process.env.AMPLOPAY_CALLBACK_URL;

    if (!callbackUrl) {
      return res.status(503).json({
        error: "AMPLOPAY_CALLBACK_URL não configurada"
      });
    }

    const gatewayBody = {
      identifier: orderId,
      amount,
      client: {
        name: String(name).trim(),
        email: String(email).trim(),
        ...(phone ? { phone: String(phone) } : {}),
        ...(cpf ? { document: String(cpf).replace(/\D/g, "") } : {})
      },
      products: selectedProducts.map(product => ({
        id: product.id,
        name: product.gateway_name || product.name,
        quantity: 1,
        price: Number(product.price),
        physical: false
      })),
      callbackUrl,
      isStrictWebhookToken: true
    };

    const gatewayResponse = await fetch(AMPLOPAY_URL, {
      method: "POST",
      headers: getGatewayCredentials(),
      body: JSON.stringify(gatewayBody),
      signal: AbortSignal.timeout(25000)
    });

    const gatewayData = await gatewayResponse.json().catch(() => ({}));

    if (!gatewayResponse.ok || !gatewayData.pix?.code) {
      console.error(
        "Falha AmploPay:",
        gatewayData.errorCode || gatewayData.message || gatewayResponse.status
      );

      return res.status(502).json({
        error: gatewayData.message || "Não foi possível gerar o PIX",
        details: gatewayData.details || undefined
      });
    }

    const initialStatus =
      gatewayData.transactionStatus === "COMPLETED"
        ? "COMPLETED"
        : "PENDING";

    await client.query("BEGIN");

    const inserted = await client.query(
      `INSERT INTO orders (
        id, attempt_id, visitor_id, product_id, bump_ids,
        customer_name, customer_email, customer_phone, customer_cpf,
        amount, status, gateway_transaction_id,
        gateway_webhook_token, pix_code, pix_image
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
      )
      RETURNING *`,
      [
        orderId,
        String(attemptId),
        visitorId ? String(visitorId) : null,
        String(productId),
        JSON.stringify(selectedBumps.map(product => product.id)),
        String(name).trim(),
        String(email).trim(),
        phone ? String(phone) : null,
        cpf ? String(cpf).replace(/\D/g, "") : null,
        amount,
        initialStatus,
        gatewayData.transactionId || null,
        gatewayData.webhookToken || null,
        gatewayData.pix.code,
        gatewayData.pix.image || null
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      configured: true,
      order: mapOrder(inserted.rows[0])
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    console.error("Erro ao criar pedido:", error.message);

    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }

    if (error.code === "23505") {
      const existing = await pool.query(
        "SELECT * FROM orders WHERE attempt_id = $1 LIMIT 1",
        [String(req.body?.attemptId || "")]
      );

      if (existing.rowCount) {
        return res.json({
          configured: true,
          order: mapOrder(existing.rows[0])
        });
      }
    }

    return res.status(500).json({
      error: "Erro interno ao criar pedido"
    });
  } finally {
    client.release();
  }
});

// ======================================
// CONSULTAR PEDIDO
// ======================================

app.get("/api/orders/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM orders
       WHERE id = $1 OR gateway_transaction_id = $1
       LIMIT 1`,
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Pedido não encontrado"
      });
    }

    return res.json({
      configured: true,
      order: mapOrder(result.rows[0])
    });
  } catch (error) {
    console.error("Erro ao consultar pedido:", error.message);
    return res.status(500).json({
      error: "Erro ao consultar pedido"
    });
  }
});

// ======================================
// WEBHOOK AMPLOPAY
// ======================================

app.post("/api/amplopay/webhook", async (req, res) => {
  try {
    const payload = req.body || {};
    const transaction = payload.transaction || {};

    if (!payload.event || !payload.token || !transaction.id) {
      return res.status(400).json({
        error: "Notificação inválida"
      });
    }

    const allowedEvents = [
      "TRANSACTION_PAID",
      "TRANSACTION_CANCELED",
      "TRANSACTION_REFUNDED",
      "TRANSACTION_CHARGED_BACK"
    ];

    if (!allowedEvents.includes(payload.event)) {
      return res.status(400).json({
        error: "Evento não aceito"
      });
    }

    const identifier = transaction.identifier;

    if (!identifier) {
      return res.status(400).json({
        error: "Identificador do pedido ausente"
      });
    }

    const result = await pool.query(
      "SELECT * FROM orders WHERE id = $1 LIMIT 1",
      [String(identifier)]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Pedido não encontrado"
      });
    }

    const order = result.rows[0];

    const expectedToken =
      order.gateway_webhook_token || process.env.GATEWAY_WEBHOOK_TOKEN;

    if (!safeEqual(payload.token, expectedToken)) {
      return res.status(401).json({
        error: "Token inválido"
      });
    }

    const statusMap = {
      TRANSACTION_PAID: "COMPLETED",
      TRANSACTION_CANCELED: "FAILED",
      TRANSACTION_REFUNDED: "REFUNDED",
      TRANSACTION_CHARGED_BACK: "CHARGED_BACK"
    };

    const newStatus = statusMap[payload.event];

    await pool.query(
      `UPDATE orders
       SET status = $2,
           gateway_transaction_id = COALESCE($3, gateway_transaction_id),
           updated_at = NOW()
       WHERE id = $1`,
      [
        order.id,
        newStatus,
        transaction.id ? String(transaction.id) : null
      ]
    );

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Erro no webhook AmploPay:", error.message);

    return res.status(500).json({
      error: "Falha ao processar notificação"
    });
  }
});

// ======================================
// ROTAS NÃO ENCONTRADAS
// ======================================

app.use((req, res) => {
  res.status(404).json({
    error: "Rota não encontrada",
    path: req.path
  });
});

// ======================================
// TRATAMENTO DE ERROS
// ======================================

app.use((err, req, res, next) => {
  console.error("Erro na aplicação:", err.message);

  if (err.message === "Origem não autorizada") {
    return res.status(403).json({
      error: "Origem não autorizada"
    });
  }

  return res.status(500).json({
    error: "Erro interno do servidor"
  });
});

// ======================================
// INICIALIZAÇÃO
// ======================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Ecred API iniciada na porta ${PORT}`);
});
