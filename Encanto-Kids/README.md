# Encanto Kids — Mercado Pago + Netlify

## Estrutura

- `public/index.html` — loja
- `public/products.json` — catálogo e preços
- `netlify/functions/criar-pagamento.js` — cria o Checkout Pro
- `netlify/functions/webhook.js` — endpoint para notificações
- `netlify.toml` — configuração da Netlify
- `package.json` — configuração do projeto

## Configuração do Mercado Pago

NÃO coloque o Access Token no GitHub, no HTML ou no products.json.

Na Netlify, abra:

Site → Project configuration → Environment variables

Adicione:

`MP_ACCESS_TOKEN` = seu Access Token de teste do Mercado Pago

Opcionalmente, se futuramente a integração precisar da chave pública:

`MP_PUBLIC_KEY` = sua Public Key de teste

O Checkout Pro desta versão usa o Access Token somente no backend; a Public Key não é necessária para criar o link de checkout.

## Teste

Use as credenciais de teste durante o desenvolvimento. Quando a loja estiver validada, substitua a variável `MP_ACCESS_TOKEN` pela credencial de produção no ambiente da Netlify.

## Deploy

1. Extraia esta pasta.
2. Suba o conteúdo de `Encanto-Kids` para um repositório GitHub.
3. Conecte o repositório à Netlify.
4. Configure `MP_ACCESS_TOKEN` nas Environment Variables da Netlify.
5. Faça um novo deploy.
