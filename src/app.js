const express = require("express")
const cors = require("cors")
const axios = require("axios")
const http = require("http")
const { Server } = require("socket.io")
const qrcode = require("qrcode")
require("dotenv").config()

const app = express()
const server = http.createServer(app)

// Update these arrays with your frontend URLs
const allowedOrigins = ["http://localhost:3000", "https://your-production-frontend-url.com"]

// CORS configuration
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true)
      } else {
        callback(new Error("Not allowed by CORS"))
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "access_token"],
    credentials: true,
    optionsSuccessStatus: 204,
  }),
)

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
})

app.use((req, res, next) => {
  const origin = req.headers.origin
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, access_token")
  res.setHeader("Access-Control-Allow-Credentials", "true")
  if (req.method === "OPTIONS") {
    return res.sendStatus(204)
  }
  next()
})

app.use(express.json())

// Configuração das variáveis de ambiente
const ASAAS_API_KEY = process.env.ASAAS_API_KEY
const ASAAS_API_URL = process.env.ASAAS_API_URL || "https://www.asaas.com/api/v3"

if (!ASAAS_API_KEY) {
  console.error("ASAAS_API_KEY is not set in the environment variables")
  process.exit(1)
}

console.log("ASAAS_API_KEY:", ASAAS_API_KEY ? `is set (length: ${ASAAS_API_KEY.length})` : "is not set")
console.log("ASAAS_API_URL:", ASAAS_API_URL)

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
      },
    )
    return response.data
  } catch (error) {
    console.error("Error creating customer in Asaas:", error.response?.data || error.message)
    throw error
  }
}

app.post("/customers", async (req, res) => {
  try {
    const { name, email, phone, cpfCnpj } = req.body
    if (!name || !email || !phone || !cpfCnpj) {
      return res.status(400).json({ error: "Name, email, phone, and CPF/CNPJ are required." })
    }

    const newCustomer = await createCustomerInAsaas(name, email, phone, cpfCnpj)
    res.status(201).json(newCustomer)
  } catch (error) {
    console.error("Error creating customer:", error.response?.data || error.message)
    if (error.response) {
      res.status(error.response.status).json({ error: error.response.data.errors || "Error creating customer" })
    } else {
      res.status(500).json({ error: "Internal server error" })
    }
  }
})

console.log("Servidor inicializado")

// Rota para criar pagamentos no Asaas
app.post("/payments", async (req, res) => {
  try {
    const { customer, value, dueDate, description, paymentMethod } = req.body
    console.log("Dados recebidos na requisição de pagamento:", { customer, value, dueDate, description, paymentMethod })

    if (!customer || !value || !dueDate || !description || !paymentMethod) {
      console.warn("Informações obrigatórias ausentes na requisição de pagamento.")
      return res.status(400).json({
        error: "Missing required payment information",
        details: { customer, value, dueDate, description, paymentMethod },
      })
    }

    const paymentData = {
      customer,
      billingType: paymentMethod,
      value: Number(value).toFixed(2),
      dueDate,
      description,
      postalService: false,
    }

    console.log("Preparando para enviar dados ao Asaas:", paymentData)

    const response = await axios.post(`${ASAAS_API_URL}/payments`, paymentData, {
      headers: {
        "Content-Type": "application/json",
        access_token: ASAAS_API_KEY,
      },
    })

    console.log("Resposta do Asaas para a criação do pagamento:", response.data)

    if (response.data.status === "PENDING") {
      // Se o pagamento foi criado com sucesso, mas ainda não temos o QR code
      // Vamos buscar as informações do PIX
      const pixResponse = await axios.get(`${ASAAS_API_URL}/payments/${response.data.id}/pixQrCode`, {
        headers: {
          "Content-Type": "application/json",
          access_token: ASAAS_API_KEY,
        },
      })

      console.log("Resposta do Asaas para o QR code PIX:", pixResponse.data)

      if (pixResponse.data.success && pixResponse.data.payload) {
        // Generate QR code
        const qrCodeImage = await qrcode.toDataURL(pixResponse.data.payload)

        // Include QR code in the response
        res.status(200).json({
          message: "Pagamento gerado com sucesso.",
          value: paymentData.value,
          customer: paymentData.customer,
          dueDate: paymentData.dueDate,
          description: paymentData.description,
          pixQrCode: pixResponse.data.payload,
          qrCodeImage: qrCodeImage,
          invoiceUrl: response.data.invoiceUrl,
        })
      } else {
        throw new Error("Não foi possível obter o QR code PIX")
      }
    } else if (response.data.status === "FAILED") {
      console.error("Pagamento falhou no Asaas:", response.data)
      console.error(
        `Erro ao finalizar pagamento - ID: ${response.data.id}, Valor: ${response.data.value}, Cliente: ${response.data.customer}`,
      )

      io.emit("paymentError", {
        message: "Pagamento falhou. Tente novamente mais tarde.",
        paymentId: response.data.id,
        status: "failed",
      })
      return res.status(400).json({
        error: "Pagamento falhou. Tente novamente mais tarde.",
        details: response.data,
      })
    }
  } catch (error) {
    console.error("Erro ao criar pagamento:", error.message, error.response?.data || "Sem resposta detalhada do Asaas")
    io.emit("paymentError", {
      message: "Erro ao gerar pagamento.",
      error: error.message,
      status: "failed",
    })
    res.status(500).json({ error: "Erro ao gerar pagamento", details: error.message })
  }
})

// Webhook com logs detalhados
app.post("/webhook", async (req, res) => {
  try {
    const { event, payment } = req.body
    console.log("Webhook recebido. Dados:", req.body)

    if (!event || !payment) {
      console.error("Dados inválidos recebidos no webhook:", req.body)
      return res.status(400).send("Dados inválidos no webhook")
    }

    if (event === "PAYMENT_RECEIVED") {
      console.log(
        `Pagamento confirmado no webhook. ID=${payment.id}, Valor=${payment.value}, Cliente=${payment.customer}`,
      )

      io.emit("paymentReceived", {
        paymentId: payment.id,
        value: payment.value,
        customer: payment.customer,
        status: "confirmed",
        message: "Pagamento confirmado com sucesso!",
      })

      return res.status(200).send("Pagamento confirmado")
    }

    if (event === "PAYMENT_FAILED") {
      console.error(
        `Pagamento falhou no webhook. ID=${payment.id}, Valor=${payment.value}, Cliente=${payment.customer}`,
      )
      console.error(`Detalhes da falha - ID: ${payment.id}, Valor: ${payment.value}, Cliente: ${payment.customer}`)

      io.emit("paymentError", {
        paymentId: payment.id,
        value: payment.value,
        customer: payment.customer,
        status: "failed",
        message: "Falha no pagamento. Tente novamente.",
      })

      return res.status(200).send("Erro no pagamento")
    }

    console.warn("Evento não reconhecido recebido no webhook:", event)
    res.status(200).send("Evento recebido")
  } catch (error) {
    console.error("Erro no processamento do webhook:", error.message)
    res.status(500).send("Erro interno no webhook")
  }
})

// Configuração do Socket.IO
let connectedClientId = null

io.on("connection", (socket) => {
  console.log("Novo cliente conectado:", socket.id)

  socket.on("join", (clientId) => {
    if (connectedClientId !== clientId) {
      console.log(`Cliente ${clientId} está tentando se conectar. Redirecionando...`)
      socket.emit("clientAlreadyConnected", { message: "Você já está conectado!" })
    } else {
      console.log(`Cliente ${clientId} conectado com sucesso.`)
      connectedClientId = clientId
    }
  })

  socket.on("paymentReceived", (paymentDetails) => {
    console.log("Pagamento recebido:", paymentDetails)
    io.emit("paymentReceived", paymentDetails)
  })

  socket.on("disconnect", () => {
    console.log("Cliente desconectado:", socket.id)
    connectedClientId = null
  })
})

// Inicializando o servidor
const PORT = process.env.PORT || 5000
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})

