const fs = require('node:fs');
const path = require('node:path');

function getCatalog() {
  const file = path.join(process.cwd(), 'public', 'products.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Método não permitido.' }) };
  }

  if (!process.env.MP_ACCESS_TOKEN) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Mercado Pago não configurado na Netlify. Adicione MP_ACCESS_TOKEN nas variáveis de ambiente.' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const productId = String(body.product_id || '');
    const quantity = Math.max(1, Math.min(10, Number(body.quantity) || 1));
    const catalog = getCatalog();
    const product = catalog.products.find((p) => p.id === productId && p.active && Number.isFinite(p.price_cents));

    if (!product) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Produto inválido ou indisponível.' }) };
    }

    const host = event.headers.host;
    const protocol = event.headers['x-forwarded-proto'] || 'https';
    const baseUrl = `${protocol}://${host}`;

    const preference = {
      items: [{
        id: product.id,
        title: product.name,
        quantity,
        currency_id: 'BRL',
        unit_price: Number(product.price_cents) / 100
      }],
      shipments: catalog.shipping?.free ? { cost: 0 } : undefined,
      external_reference: `encanto-${product.id}-${Date.now()}`,
      back_urls: {
        success: `${baseUrl}/?pagamento=sucesso`,
        failure: `${baseUrl}/?pagamento=falhou`,
        pending: `${baseUrl}/?pagamento=pendente`
      },
      auto_return: 'approved'
    };

    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`
      },
      body: JSON.stringify(preference)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Mercado Pago:', response.status, data);
      return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Não foi possível criar o checkout no Mercado Pago.' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ init_point: data.init_point, preference_id: data.id })
    };
  } catch (error) {
    console.error(error);
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Dados inválidos.' }) };
  }
};
