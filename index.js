import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// CONFIG Z-API
const INSTANCE_ID = "3EB34863266AE1B6AC8C2E0261F7EA9D";
const TOKEN = "BFEA077E388CB40BA8C9F017";

// URL BASE DA Z-API
const ZAPI_URL = `https://api.z-api.io/instances/${INSTANCE_ID}/token/${TOKEN}`;

// ROTA DO WEBHOOK
app.post("/webhook", async (req, res) => {
    console.log("📩 Webhook recebido:", req.body);

    const phone = req.body.phone;
    const message =
        req.body.text?.body ||
        req.body.message ||
        req.body.body ||
        "";

    if (!phone) {
        console.log("❗ Nenhum telefone detectado no webhook");
        return res.sendStatus(200);
    }

    console.log("📲 Mensagem recebida de:", phone);
    console.log("📝 Conteúdo:", message);

    // Mensagem de teste automática
    const reply = "Olá! Recebi sua mensagem com sucesso. Seu bot está funcionando!";

    try {
        const response = await axios.post(
            `${ZAPI_URL}/send-text`,
            {
                phone: phone,
                message: reply
            }
        );

        console.log("✅ Mensagem enviada pela Z-API:", response.data);
    } catch (error) {
        console.error("❌ Erro ao enviar mensagem:", error.response?.data || error);
    }

    res.sendStatus(200);
});

// PORTA DO RENDER
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Cantina bot rodando na porta ${PORT}`);
});

