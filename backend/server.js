
import express from "express";
import cors from "cors";
import helmet from "helmet";
import pg from "pg";

const { Pool } = pg;
const app = express();

app.disable("x-powered-by");

app.use(helmet());

// ======================================
// CORS
// ======================================

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
// TESTE DO BANCO DE DADOS
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
    console.error("Falha no teste PostgreSQL:", error.message);

    return res.status(503).json({
      status: "error",
      message: "Não foi possível conectar ao banco de dados"
    });
  }
});

// ======================================
// CONSULTA CPF - SEARCHAPI
// ======================================

app.post("/api/cpf-test", async (req, res) => {
  const startedAt = Date.now();

  try {
    // Recebe e valida o CPF
    const cpf = String(req.body?.cpf || "")
      .replace(/\D/g, "");

    if (cpf.length !== 11) {
      return res.status(400).json({
        configured: true,
        ok: false,
        status: 400,
        elapsedMs: Date.now() - startedAt,
        error: "CPF deve conter 11 dígitos"
      });
    }

    // Carrega as variáveis da Railway
    const baseUrl = process.env.SEARCHAPI_BASE_URL;
    const token = process.env.SEARCHAPI_TOKEN_API;

    if (!baseUrl || !token) {
      return res.status(200).json({
        configured: false,
        ok: false,
        status: 0,
        elapsedMs: Date.now() - startedAt,
        error: "SearchAPI não configurada na Railway"
      });
    }

    // Monta a URL da SearchAPI
    const url = new URL(baseUrl);

    url.searchParams.set("cpf", cpf);
    url.searchParams.set("token_api", token);

    // Consulta o provedor
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(20000)
    });

    const responseText = await response.text();

    let apiData;

    try {
      apiData = JSON.parse(responseText);
    } catch {
      apiData = null;
    }

    const elapsedMs = Date.now() - startedAt;

    // Verifica a resposta
    if (!response.ok || !apiData) {
      console.error(
        "Erro SearchAPI. Status HTTP:",
        response.status
      );

      return res.status(200).json({
        configured: true,
        ok: false,
        status: response.status,
        elapsedMs,
        error: "Erro na resposta da SearchAPI"
      });
    }

    // Extrai o registro retornado
    const registro = Array.isArray(apiData.dados)
      ? apiData.dados[0]
      : apiData.dados || null;

    if (!registro || typeof registro !== "object") {
      return res.status(200).json({
        configured: true,
        ok: false,
        status: response.status,
        elapsedMs,
        error: apiData.status || "Nenhum registro encontrado"
      });
    }

    // Converte os campos da SearchAPI
    // para o formato esperado pelo painel Ecred
    const dadosFormatados = {
      cpf: registro.CPF || cpf,
      name: registro.NOME || "",
      birthDate: registro.NASC || "",
      motherName: registro.NOME_MAE || ""
    };

    return res.status(200).json({
      configured: true,
      ok: Boolean(dadosFormatados.name),
      status: response.status,
      elapsedMs,
      data: dadosFormatados,
      error: dadosFormatados.name
        ? null
        : "O registro não possui nome disponível"
    });

  } catch (error) {
    console.error(
      "Falha na consulta SearchAPI:",
      error.name,
      error.message
    );

    return res.status(200).json({
      configured: Boolean(
        process.env.SEARCHAPI_BASE_URL &&
        process.env.SEARCHAPI_TOKEN_API
      ),
      ok: false,
      status: 0,
      elapsedMs: Date.now() - startedAt,
      error: error.name === "TimeoutError"
        ? "Tempo limite da SearchAPI excedido"
        : "Falha ao conectar com a SearchAPI"
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
