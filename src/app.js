const express = require("express");
const axios = require("axios");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const qrcode = require("qrcode");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Permitir todas as origens (modifique conforme necessário)
    methods: ["GET", "POST"], // Métodos permitidos
  },
});

const corsOptions = {
  origin: ["http://localhost:3000", "https://aasaasteste-production.up.railway.app"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "access_token"],
  credentials: true,
}

// Middleware de CORS
app.use(cors(corsOptions))

// Middleware para requisições OPTIONS (preflight)
app.options("*", cors(corsOptions))

// Configurações de CORS;
app.use(express.json())

// Configuração das variáveis de ambiente
const ASAAS_API_KEY = "$aact_MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OjVkNzVjZmJhLTU3YWEtNGQ0YS05NjkxLWM1MDkwMmE3ZTFhODo6JGFhY2hfYzU4MmU4NWYtNmZlOS00ODQ2LTkzNTMtNzUxNTZkNmNjYzM2";
const ASAAS_API_URL = "https://www.asaas.com/api/v3";

if (!ASAAS_API_KEY) {
  console.error("ASAAS_API_KEY is not set in the environment variables");
  process.exit(1);
}

console.log("ASAAS_API_KEY:", ASAAS_API_KEY ? `is set (length: ${ASAAS_API_KEY.length})` : "is not set");
console.log("ASAAS_API_URL:", ASAAS_API_URL);

// Rota para criar um cliente no Asaas
async function createCustomerInAsaas(name, email, phone, cpfCnpj) {
  try {
    const response = await axios.post(
      `${ASAAS_API_URL}/customers`,
      { name, email, phone, mobilePhone: phone, cpfCnpj },
      {
        headers: {
          "Content-Type": "application/json",
          access_token: ASAAS_API_KEY,
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error creating customer in Asaas:", error.response?.data || error.message);
    throw error;
  }
}

app.post("/customers", async (req, res) => {
  try {
    const { name, email, phone, cpfCnpj } = req.body;
    if (!name || !email || !phone || !cpfCnpj) {
      return res.status(400).json({ error: "Name, email, phone, and CPF/CNPJ are required." });
    }

    const newCustomer = await createCustomerInAsaas(name, email, phone, cpfCnpj);
    res.status(201).json(newCustomer);
  } catch (error) {
    console.error("Error creating customer:", error.response?.data || error.message);
    if (error.response) {
      res.status(error.response.status).json({ error: error.response.data.errors || "Error creating customer" });
    } else {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

console.log("Servidor inicializado");

// Rota para criar pagamentos no Asaas
app.post("/payments", async (req, res) => {
  try {
    const { customer, value, dueDate, description, paymentMethod } = req.body;
    console.log("Dados recebidos na requisição de pagamento:", { customer, value, dueDate, description, paymentMethod });

    if (!customer || !value || !dueDate || !description || !paymentMethod) {
      console.warn("Informações obrigatórias ausentes na requisição de pagamento.");
      return res.status(400).json({
        error: "Missing required payment information",
        details: { customer, value, dueDate, description, paymentMethod },
      });
    }

    const paymentData = {
      customer,
      billingType: paymentMethod,
      value: parseFloat(value).toFixed(2),
      dueDate,
      description,
      postalService: false,
      pixKey: "vieira.cuio@gmail.com",
    };

    console.log("Preparando para enviar dados ao Asaas:", paymentData);

    const response = await axios.post(`${ASAAS_API_URL}/payments`, paymentData, {
      headers: {
        "Content-Type": "application/json",
        access_token: ASAAS_API_KEY,
      },
    });

    console.log("Resposta do Asaas para a criação do pagamento:", response.data);

    if (response.data.status === "FAILED") {
      console.error("Pagamento falhou no Asaas:", response.data);
      // Aqui podemos adicionar mais detalhes no log
      console.error(`Erro ao finalizar pagamento - ID: ${response.data.id}, Valor: ${response.data.value}, Cliente: ${response.data.customer}`);

      io.emit("paymentError", {
        message: "Pagamento falhou. Tente novamente mais tarde.",
        paymentId: response.data.id,
        status: "failed",
      });
      return res.status(400).json({
        error: "Pagamento falhou. Tente novamente mais tarde.",
        details: response.data,
      });
    }

    // Generate QR code
    const qrCodeImage = await qrcode.toDataURL(response.data.pixQrCode);

    // Include QR code in the response
    res.status(200).json({
      message: "Pagamento gerado com sucesso.",
      value: paymentData.value,
      customer: paymentData.customer,
      dueDate: paymentData.dueDate,
      description: paymentData.description,
      pixQrCode: response.data.pixQrCode,
      qrCodeImage: qrCodeImage
    });
  } catch (error) {
    console.error("Erro ao criar pagamento:", error.message, error.response?.data || "Sem resposta detalhada do Asaas");
    io.emit("paymentError", {
      message: "Erro ao gerar pagamento.",
      error: error.message,
      status: "failed",
    });
    res.status(500).json({ error: "Erro ao gerar pagamento", details: error.message });
  }
});

app.post('/proxy/cobrancas', async (req, res) => {
  console.log('Requisição recebida na rota /proxy/cobrancas');

  try {
    console.log("Requisição recebida para /proxy/cobrancas:", req.body);

    // Enviar a requisição para a API do Asaas
    const response = await axios.post('https://www.asaas.com/api/v3/payments', req.body, {
      headers: {
        'Content-Type': 'application/json',
        'access_token': ASAAS_API_KEY, // Passando o token do frontend
      },
    });

    console.log("Resposta recebida do Asaas:", response.data);

    // Validar se a API retornou o link de pagamento
    if (!response.data.invoiceUrl) {
      console.error("Erro: Link de pagamento (invoiceUrl) não encontrado na resposta do Asaas.");
      return res.status(500).json({
        error: "Link de pagamento não disponível.",
        details: "A API do Asaas não retornou o campo invoiceUrl.",
      });
    }

    // Retorna somente o link da fatura
    res.json({
      message: "Cobrança criada com sucesso.",
      invoiceUrl: response.data.invoiceUrl,
    });

  } catch (error) {
    // Verifica se há uma resposta de erro da API
    if (error.response) {
      console.error("Erro na API do Asaas:", error.response.data);
      res.status(error.response.status).json({
        error: "Erro ao criar cobrança no Asaas",
        details: error.response.data, // Inclua detalhes do erro
      });
    } else if (error.request) {
      // Se a requisição foi feita, mas sem resposta (sem resposta da API)
      console.error("Nenhuma resposta recebida da API do Asaas:", error.request);
      res.status(500).json({
        error: "Sem resposta da API do Asaas",
        details: error.request,
      });
    } else {
      // Se houve um erro inesperado
      console.error("Erro desconhecido ao criar cobrança:", error.message);
      res.status(500).json({
        error: "Erro desconhecido ao criar cobrança",
        details: error.message,
      });
    }
  }
});


// Webhook com logs detalhados
app.post("/webhook", async (req, res) => {
  try {
    const { event, payment } = req.body;
    console.log("Webhook recebido. Dados:", req.body);

    if (!event || !payment) {
      console.error("Dados inválidos recebidos no webhook:", req.body);
      return res.status(400).send("Dados inválidos no webhook");
    }

    if (event === "PAYMENT_RECEIVED") {
      console.log(`Pagamento confirmado no webhook. ID=${payment.id}, Valor=${payment.value}, Cliente=${payment.customer}`);
    
      io.emit("paymentReceived", {
        paymentId: payment.id,
        value: payment.value,
        customer: payment.customer,
        status: "confirmed",
        message: "Pagamento confirmado com sucesso!",
      });
    
      return res.status(200).send("Pagamento confirmado");
    }

    if (event === "PAYMENT_FAILED") {
      console.error(`Pagamento falhou no webhook. ID=${payment.id}, Valor=${payment.value}, Cliente=${payment.customer}`);
      // Mais informações no log
      console.error(`Detalhes da falha - ID: ${payment.id}, Valor: ${payment.value}, Cliente: ${payment.customer}`);

      io.emit("paymentError", {
        paymentId: payment.id,
        value: payment.value,
        customer: payment.customer,
        status: "failed",
        message: "Falha no pagamento. Tente novamente.",
      });

      return res.status(200).send("Erro no pagamento");
    }

    console.warn("Evento não reconhecido recebido no webhook:", event);
    res.status(200).send("Evento recebido");
  } catch (error) {
    console.error("Erro no processamento do webhook:", error.message);
    res.status(500).send("Erro interno no webhook");
  }
});

// Configuração do Socket.IO
let connectedClientId = null;

io.on("connection", (socket) => {
  console.log("Novo cliente conectado:", socket.id);

  // Verifica se o cliente já está conectado, evitando múltiplas conexões
  socket.on("join", (clientId) => {
    if (connectedClientId !== clientId) {
      console.log(`Cliente ${clientId} está tentando se conectar. Redirecionando...`);
      socket.emit("clientAlreadyConnected", { message: "Você já está conectado!" });
    } else {
      console.log(`Cliente ${clientId} conectado com sucesso.`);
      connectedClientId = clientId; // Armazena o ID do cliente
    }
  });

  // Enviar um evento de pagamento recebido para o cliente
  socket.on("paymentReceived", (paymentDetails) => {
    console.log("Pagamento recebido:", paymentDetails);
    io.emit("paymentReceived", paymentDetails); // Emite o evento para todos os clientes conectados
  });

  // Escutando o evento de desconexão
  socket.on("disconnect", () => {
    console.log("Cliente desconectado:", socket.id);
    connectedClientId = null; // Limpa a referência do cliente desconectado
  });
});

// Inicializando o servidor
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

