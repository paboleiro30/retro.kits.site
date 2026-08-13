// supabase/functions/conekta-charge/index.ts
//
// Recibe un token de tarjeta (generado en el navegador con Conekta.js) y
// hace el cobro real usando la llave PRIVADA de Conekta, guardada como
// secreto de este proyecto (nunca viaja al navegador). También registra
// el pedido en la tabla `orders`.
//
// Despliegue:
//   supabase functions deploy conekta-charge
//
// Secreto requerido (ya lo configuraste):
//   CONEKTA_PRIVATE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CONEKTA_PRIVATE_KEY = Deno.env.get("CONEKTA_PRIVATE_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { token_id, amount, customer, items, user_id, subtotal, discount, promo_code } = body;

    if (!token_id || !amount || !customer || !customer.email) {
      return new Response(
        JSON.stringify({ status: "error", message: "Faltan datos para procesar el pago." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Conekta usa centavos (MXN * 100).
    const amountCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return new Response(
        JSON.stringify({ status: "error", message: "Monto inválido." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const lineItems = (items || []).map((i: any) => ({
      name: `${i.name}${i.size ? " - Talla " + i.size : ""}`.slice(0, 250),
      unit_price: Math.round(Number(i.price) * 100),
      quantity: i.quantity,
    }));

    const conektaResp = await fetch("https://api.conekta.io/orders", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(CONEKTA_PRIVATE_KEY + ":"),
        "Content-Type": "application/json",
        Accept: "application/vnd.conekta-v2.1.0+json",
      },
      body: JSON.stringify({
        currency: "MXN",
        customer_info: {
          name: customer.name,
          email: customer.email,
          phone: customer.phone || undefined,
        },
        line_items: lineItems.length > 0 ? lineItems : [{ name: "Pedido Retro Kits", unit_price: amountCents, quantity: 1 }],
        charges: [
          {
            payment_method: {
              type: "card",
              token_id: token_id,
            },
          },
        ],
      }),
    });

    const conektaData = await conektaResp.json();

    if (!conektaResp.ok) {
      const message = conektaData?.details?.[0]?.message || conektaData?.message || "El pago fue rechazado.";
      return new Response(
        JSON.stringify({ status: "declined", message }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const charge = conektaData.charges?.data?.[0];
    const paid = charge?.status === "paid" || conektaData.payment_status === "paid";

    // Registramos el pedido en Supabase (con la service role key, evitando
    // depender de RLS del lado del navegador).
    let orderId: string | null = null;
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data, error } = await supabaseAdmin
        .from("orders")
        .insert({
          user_id: user_id || null,
          items: items || [],
          subtotal: subtotal ?? amount,
          discount: discount ?? 0,
          total: amount,
          promo_code: promo_code || null,
          payment_method: "card",
          payment_status: paid ? "pagado" : "fallido",
          conekta_order_id: conektaData.id,
          guest_name: user_id ? null : customer.name,
          guest_email: user_id ? null : customer.email,
          guest_phone: user_id ? null : customer.phone,
        })
        .select("id")
        .single();

      if (!error) orderId = data?.id ?? null;
      else console.error("Error guardando pedido:", error.message);
    }

    if (!paid) {
      return new Response(
        JSON.stringify({ status: "declined", message: "El pago no se completó. Intenta con otra tarjeta." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ status: "paid", order_id: orderId, conekta_order_id: conektaData.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Error en conekta-charge:", err);
    return new Response(
      JSON.stringify({ status: "error", message: "Error interno al procesar el pago." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
