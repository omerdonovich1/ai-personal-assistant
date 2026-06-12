// Shopify Admin API service layer (GraphQL, fetch-based — no SDK).
// Env: SHOPIFY_STORE        (e.g. "onde-jewelry" → onde-jewelry.myshopify.com)
//      SHOPIFY_ADMIN_TOKEN  (Admin API access token, shpat_...)

const API_VERSION = "2025-01";

export function shopifyConfigured(): boolean {
  return Boolean(process.env.SHOPIFY_STORE && process.env.SHOPIFY_ADMIN_TOKEN);
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) throw new Error("Shopify לא מוגדר — חסרים SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN");

  const res = await fetch(`https://${store}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify: ${res.status} ${await res.text().catch(() => "")}`);
  const data = await res.json() as { data: T; errors?: Array<{ message: string }> };
  if (data.errors?.length) throw new Error(`Shopify GraphQL: ${data.errors[0].message}`);
  return data.data;
}

export interface ShopifySummary {
  ordersLast24h: number;
  revenueLast24h: string;
  lowStock: Array<{ title: string; available: number }>;
}

export async function shopifySummary(lowStockThreshold = 5): Promise<ShopifySummary> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const orders = await gql<{
    orders: { edges: Array<{ node: { totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } } }> };
  }>(
    `query($q: String!) {
      orders(first: 50, query: $q) {
        edges { node { totalPriceSet { shopMoney { amount currencyCode } } } }
      }
    }`,
    { q: `created_at:>=${since}` }
  );

  const edges = orders.orders.edges;
  const total = edges.reduce((s, e) => s + parseFloat(e.node.totalPriceSet.shopMoney.amount), 0);
  const currency = edges[0]?.node.totalPriceSet.shopMoney.currencyCode ?? "ILS";

  const inv = await gql<{
    productVariants: { edges: Array<{ node: { displayName: string; inventoryQuantity: number } }> };
  }>(
    `query {
      productVariants(first: 100) {
        edges { node { displayName inventoryQuantity } }
      }
    }`
  );

  const lowStock = inv.productVariants.edges
    .map((e) => ({ title: e.node.displayName, available: e.node.inventoryQuantity }))
    .filter((v) => v.available >= 0 && v.available <= lowStockThreshold)
    .sort((a, b) => a.available - b.available)
    .slice(0, 10);

  return {
    ordersLast24h: edges.length,
    revenueLast24h: `${total.toFixed(0)} ${currency}`,
    lowStock,
  };
}
