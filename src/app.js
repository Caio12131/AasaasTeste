const express = require("express")
const cors = require("cors")
const axios = require("axios")
const http = require("http")
const { Server } = require("socket.io")
const qrcode = require("qrcode")
require("dotenv").config()

const app = express()
const server = http.createServer(app)

const allowedOrigins = ["http://localhost:3000", "https://asaasfrontteste-production.up.railway.app"]

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
  }),
)

app.use(express.json())

const ASAAS_API_KEY = process.env.ASAAS_API_KEY
const ASAAS_API_URL = process.env.ASAAS_API_URL || "https://www.asaas.com/api/v3"

if (!ASAAS_API_KEY) {
  console.error("ASAAS_API_KEY is not set in the environment variables")
  process.exit(1)
}

console.log("ASAAS_API_KEY:", ASAAS_API_KEY ? `is set (length: ${ASAAS_API_KEY.length})` : "is not set")
console.log("ASAAS_API_URL:", ASAAS_API_URL)

async function createOrUpdateCustomer(name, email) {
  try {
    const customerResponse = await axios.get(`${ASAAS_API_URL}/customers?email=${email}`, {
      headers: {
        "Content-Type": "application/json",
        access_token: ASAAS_API_KEY,
      },
    })

    if (customerResponse.data.data.length > 0) {
      const customerId = customerResponse.data.data[0].id
      await axios.post(
        `${ASAAS_API_URL}/customers/${customerId}`,
        { name, email },
        {
          headers: {
            "Content-Type": "application/json",
            access_token: ASAAS_API_KEY,
          },
        },
      )
      return customerId
    } else {
      const newCustomerResponse = await axios.post(
        `${ASAAS_API_URL}/customers`,
        { name, email },
        {
          headers: {
            "Content-Type": "application/json",
            access_token: ASAAS_API_KEY,
          },
        },
      )
      return newCustomerResponse.data.id
    }
  } catch (error) {
    console.error("Erro ao criar ou atualizar cliente:", error.message)
    throw error
  }
}

app.post("/payments", async (req, res) => {
  try {
    const { value, description } = req.body
    console.log("Dados recebidos na requisição de pagamento:", { value, description })

    // Verifica se os campos obrigatórios estão presentes
    if (!value || !description) {
      console.warn("Informações obrigatórias ausentes na requisição de pagamento.")
      return res.status(400).json({
        error: "Informações de pagamento obrigatórias ausentes",
        details: { value, description },
      })
    }

    // Prepara os dados para a criação do QR Code estático
    const pixPaymentData = {
      value: Number(value).toFixed(2),
      description,
    }

    console.log("Preparando para enviar dados ao Asaas:", pixPaymentData)

    // Faz a requisição para criar o QR Code estático
    const response = await axios.post(`${ASAAS_API_URL}/pix/qrCodes/static`, pixPaymentData, {
      headers: {
        "Content-Type": "application/json",
        access_token: ASAAS_API_KEY,
      },
    })

    console.log("Resposta do Asaas para a criação do QR Code PIX:", response.data)

    // Verifica se a resposta contém os dados esperados
    if (response.data && response.data.encodedImage && response.data.payload) {
      res.status(200).json({
        message: "Pagamento PIX gerado com sucesso.",
        value: pixPaymentData.value,
        description: pixPaymentData.description,
        pixQrCode: response.data.payload,
        qrCodeImage: `data:image/png;base64,${response.data.encodedImage}`, // Certifique-se de adicionar o prefixo base64
      })
    } else {
      throw new Error("Não foi possível obter o QR Code PIX")
    }
  } catch (error) {
    console.error("Erro ao criar pagamento PIX:", error.message)
    console.error("Detalhes do erro:", error.response?.data || "Sem resposta detalhada do Asaas")
    res.status(500).json({
      error: "Erro ao gerar pagamento PIX",
      details: error.response?.data || error.message,
    })
  }
})

app.post("/webhook", async (req, res) => {
  try {
    const { event, payment } = req.body
    console.log("Webhook recebido. Dados:", req.body)

    if (!event || !payment) {
      console.error("Dados inválidos recebidos no webhook:", req.body)
      return res.status(400).send("Dados inválidos no webhook")
    }

    switch (event) {
      case "PAYMENT_CREATED":
        console.log(`Pagamento PIX criado. ID=${payment.id}, Valor=${payment.value}`)
        io.emit("paymentCreated", {
          paymentId: payment.id,
          value: payment.value,
          status: "created",
          message: "Pagamento PIX criado com sucesso!",
        })
        break
      case "PAYMENT_RECEIVED":
        console.log(`Pagamento PIX recebido. ID=${payment.id}, Valor=${payment.value}`)
        io.emit("paymentReceived", {
          paymentId: payment.id,
          value: payment.value,
          status: "confirmed",
          message: "Pagamento PIX confirmado com sucesso!",
        })
        break
      case "PAYMENT_UPDATED":
        console.log(`Pagamento PIX atualizado. ID=${payment.id}, Valor=${payment.value}, Status=${payment.status}`)
        io.emit("paymentUpdated", {
          paymentId: payment.id,
          value: payment.value,
          status: payment.status,
          message: `Status do pagamento PIX atualizado para ${payment.status}`,
        })
        break
      default:
        console.warn("Evento não reconhecido recebido no webhook:", event)
    }

    res.status(200).send("Evento processado com sucesso")
  } catch (error) {
    console.error("Erro no processamento do webhook:", error.message)
    res.status(500).send("Erro interno no webhook")
  }
})

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
})

io.on("connection", (socket) => {
  console.log("Novo cliente conectado:", socket.id)

  socket.on("disconnect", () => {
    console.log("Cliente desconectado:", socket.id)
  })
})

const PORT = process.env.PORT || 5000
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})

