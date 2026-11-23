
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

// Conexão com o PostgreSQL existente
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  max: 5
});

// Teste básico da API
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "online",
    service: "ecred-api",
    timestamp: new Date().toISOString()
  });
});

// Teste real do PostgreSQL
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
    console.error("Falha no teste de conexão PostgreSQL");

    return res.status(503).json({
      status: "error",
      message: "Não foi possível conectar ao banco de dados"
    });
  }
});

app.use((err, req, res, next) => {
  console.error("Erro na aplicação");

  res.status(500).json({
    error: "Erro interno do servidor"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Ecred API iniciada na porta ${PORT}`);
});
