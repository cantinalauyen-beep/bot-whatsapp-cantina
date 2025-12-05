
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  console.log("Webhook recebido:", req.body);

  const body = req.body;

  // Pega número e texto corretamente
  const phone = body.phone;
  const message = body.text;

  // Se não tiver texto, ignora
  if (!message) {
    console.log("Mensagem sem texto. Ignorando.");
    return res.sendStatus(200);
  }

  console.log(`Mensagem recebida de ${phone}: ${message}`);

  // Resposta simples para testar
  await sendMessage(phone, "Recebi sua mensagem! O bot está funcionando 🚀");

  res.sendStatus(200);
});

// ----- Função para enviar mensagens -----
async function sendMessage(phone, text) {
  try {
    await fetch("https://wpp-store-api.onrender.com/api/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        number: phone,
        text: text
      }),
    });
    console.log("Mensagem enviada!");
  } catch (err) {
    console.error("Erro ao enviar mensagem:", err);
  }
}

app.listen(10000, () => console.log("Cantina bot running"));
