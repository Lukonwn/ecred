
import express from "express";
import cors from "cors";
import helmet from "helmet";
import pg from "pg";

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
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Origem não autorizada"));
  }
}));

app.use(express.json({ limit: "20kb" }));

// ======================================
// POSTGRESQL
// ======================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  max: 5
});

// ======================================
// FUNÇÃO DE CONSULTA SEARCHAPI
// ======================================

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
    headers: {
      Accept: "application/json"
    },
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

// ======================================
// EXTRAÇÃO DOS DADOS
// ======================================

function extrairRegistro(result) {
  const dados = result?.dados;

  if (Array.isArray(dados)) {
    return dados[0] || null;
  }

  if (dados && typeof dados === "object") {
    return dados;
  }

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

// ======================================
// TESTE POSTGRESQL
// ======================================

app.get("/health/db", async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({
      status: "error",
      message: "DATABASE_URL não configurada"
    });
  }

  try {
    const result = await pool.query(
      "SELECT NOW() AS database_time"
    );

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
    const cpf = String(req.body?.cpf || "")
      .replace(/\D/g, "");

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
  const startedAt = Date.now();

  try {
    const cpf = String(req.body?.cpf || "")
      .replace(/\D/g, "");

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

    // Campos diretamente na raiz:
    // é o formato esperado pela chamada do checkout.
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
