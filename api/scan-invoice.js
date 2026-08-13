// Función serverless (Vercel). Recibe la(s) foto(s) de la factura desde la app,
// llama a la API de Anthropic usando la llave secreta guardada en el servidor
// (variable de entorno ANTHROPIC_API_KEY), y regresa los renglones ya extraídos.
// La llave NUNCA se manda al navegador — por eso este paso intermedio es necesario.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Falta configurar ANTHROPIC_API_KEY en el servidor" });
    return;
  }

  // Acepta una sola imagen (campo "image", formato viejo) o varias (campo "images", array — para facturas de varias hojas)
  const { image, images } = req.body || {};
  const listaImagenes = Array.isArray(images) && images.length > 0 ? images : (image ? [image] : []);
  if (listaImagenes.length === 0) {
    res.status(400).json({ error: "Falta la imagen" });
    return;
  }

  const prompt = listaImagenes.length > 1
    ? `Eres un asistente que lee fotos de facturas o tickets de compra de materiales (ferretería, Home Depot, etc). Te voy a mandar ${listaImagenes.length} fotos — son varias hojas de LA MISMA factura/ticket, en orden. Junta los renglones de todas las hojas en una sola lista. Devuelve SOLO un objeto JSON, sin texto adicional, sin explicaciones, sin backticks de markdown, con esta forma exacta:
{"tienda": string o null, "fecha": "YYYY-MM-DD" o null, "items": [{"descripcion": string, "numeroProducto": string o null, "cantidad": number, "precioUnitario": number o null, "importe": number}], "total": number o null}
Reglas: usa el año actual si el ticket no trae año completo. Si no puedes leer un campo, usa null. No inventes renglones que no aparezcan en las imágenes. No repitas un renglón que ya aparezca en otra hoja. "importe" es el precio total de esa línea (cantidad x precio unitario), no el subtotal del ticket.`
    : `Eres un asistente que lee fotos de facturas o tickets de compra de materiales (ferretería, Home Depot, etc). Devuelve SOLO un objeto JSON, sin texto adicional, sin explicaciones, sin backticks de markdown, con esta forma exacta:
{"tienda": string o null, "fecha": "YYYY-MM-DD" o null, "items": [{"descripcion": string, "numeroProducto": string o null, "cantidad": number, "precioUnitario": number o null, "importe": number}], "total": number o null}
Reglas: usa el año actual si el ticket no trae año completo. Si no puedes leer un campo, usa null. No inventes renglones que no aparezcan en la imagen. "importe" es el precio total de esa línea (cantidad x precio unitario), no el subtotal del ticket.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        messages: [
          {
            role: "user",
            content: [
              ...listaImagenes.map((img) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img } })),
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      res.status(response.status).json({ error: data?.error?.message || "Error de Anthropic" });
      return;
    }

    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) {
      res.status(502).json({ error: "Sin respuesta de la IA" });
      return;
    }

    const clean = textBlock.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message || "Error inesperado" });
  }
}
