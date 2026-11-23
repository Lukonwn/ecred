
import express from "express";
import cors from "cors";
import helmet from "helmet";

const app = express();

app.disable("x-powered-by");

app.use(helmet());

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Permite chamadas sem Origin, como verificações internas.
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Origem não autorizada"));
  }
}));

app.use(express.json({ limit: "20kb" }));

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "online",
    service: "ecred-api",
    timestamp: new Date().toISOString()
  });
});

app.use((err, req, res, next) => {
  console.error("Erro na aplicação:", err.message);

  res.status(500).json({
    error: "Erro interno do servidor"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Ecred API iniciada na porta ${PORT}`);
});
