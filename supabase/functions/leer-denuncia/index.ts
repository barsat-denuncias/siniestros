// ============================================================================
// LECTURA DE DENUNCIAS EN PAPEL CON IA
// La pagina manda las fotos de las hojas del formulario ANEXO I de AON escrito
// a mano; esta funcion se las pasa a Claude Haiku y devuelve los datos en JSON
// para completar el formulario.
//
// La clave de Anthropic vive SOLO aca, como secreto ANTHROPIC_API_KEY de
// Supabase (Edge Functions > Secrets). Nunca en la pagina: el repo es publico.
//
// Limites (protegen el saldo):
//   - 3 lecturas por denuncia (lectura_id, lo genera la pagina por denuncia),
//     y 6 intentos en total contando los que fallaron
//   - MAX_LECTURAS_POR_DIA entre todas las denuncias, en 24 hs corridas,
//     contando tambien los intentos fallidos
//   - el dominio tiene que ser de la flota
// Una lectura que falla por culpa de la IA (saturada, caida) no gasta una de las 3.
//
// Probado el 13 y 14/10/2026 con 10 denuncias reales: Haiku acerto el 95% de
// los datos y nunca puso un dato mal sin marcarlo como dudoso.
// ============================================================================
import Anthropic from "npm:@anthropic-ai/sdk";
import postgres from "npm:postgres@3";

const MODELO = "claude-haiku-5-5";
const MAX_LECTURAS_POR_DENUNCIA = 3;
const MAX_INTENTOS_POR_DENUNCIA = 6;   // contando los que fallaron por la IA
const MAX_LECTURAS_POR_DIA = 60;       // todas las denuncias juntas, en 24 hs
const MAX_PAGINAS = 3;
const MAX_BASE64_POR_PAGINA = 3_500_000;   // ~2,6 MB de JPEG; la pagina manda ~0,5 MB

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });

// Se crea al primer pedido: si el secreto todavia no esta cargado, la funcion
// contesta "no activada" en vez de no arrancar.
let anthropic: Anthropic | null = null;
function clienteIA(): Anthropic | null {
    const clave = Deno.env.get("ANTHROPIC_API_KEY");
    if (!clave) return null;
    anthropic ??= new Anthropic({
        apiKey: clave,
        timeout: 110_000,   // la funcion tiene ~150 s de vida
        maxRetries: 1,
    });
    return anthropic;
}

// Desde donde se puede llamar (GitHub Pages, Cloudflare Pages y sus previews, y pruebas locales)
function origenPermitido(o: string | null): boolean {
    if (!o) return false;
    return o === "https://barsat-denuncias.github.io"
        || o === "https://siniestros.pages.dev"
        || /^https:\/\/[a-z0-9-]+\.siniestros\.pages\.dev$/.test(o)
        || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}

function cors(origen: string | null): Record<string, string> {
    return {
        "Access-Control-Allow-Origin": origenPermitido(origen) ? origen! : "https://siniestros.pages.dev",
        "Access-Control-Allow-Headers": "apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
    };
}

function responder(origen: string | null, status: number, cuerpo: unknown): Response {
    return new Response(JSON.stringify(cuerpo), {
        status,
        headers: { ...cors(origen), "Content-Type": "application/json" },
    });
}

// La pagina usa la clave publica nueva (sb_publishable_...). Esa clave no es un
// JWT, asi que el control automatico de Supabase (verify_jwt) no sirve: se
// compara aca contra las claves publicas del proyecto.
function clavePublicaValida(req: Request): boolean {
    const enviada = req.headers.get("apikey") || "";
    try {
        const claves = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
        return Object.values(claves).includes(enviada);
    } catch {
        return false;
    }
}

// --------------------------------------------------------------------------
// Que se le pide a la IA. Mismas reglas que en la prueba (PRUEBA IA BARSAT),
// mas la provincia del conductor, que el formulario de la app tambien pide.
// --------------------------------------------------------------------------
const CAMPOS = [
    "fecha", "hora", "localidad", "provincia", "calle", "interseccion", "dominio_propio",
    "conductor_nombre", "conductor_dni", "conductor_telefono", "conductor_domicilio",
    "conductor_localidad", "conductor_provincia", "conductor_cp", "danos_propios", "relato",
    "tercero_dominio", "tercero_marca_modelo", "tercero_aseguradora", "tercero_poliza", "tercero_danos",
    "tercero_propietario_nombre", "tercero_propietario_documento", "tercero_propietario_telefono",
    "tercero_conductor_es_propietario", "tercero_conductor_nombre", "tercero_conductor_dni",
    "tercero_conductor_telefono", "hubo_lesionados",
];

const ESQUEMA = {
    type: "object",
    properties: {
        ...Object.fromEntries(CAMPOS.map((c) => [c, { type: "string" }])),
        campos_dudosos: { type: "array", items: { type: "string" } },
    },
    required: [...CAMPOS, "campos_dudosos"],
    additionalProperties: false,
};

const INSTRUCCIONES = `Sos un asistente que pasa a datos una denuncia de siniestro de automotor escrita A MANO
sobre el formulario impreso "ANEXO I - DENUNCIA DE SINIESTRO - AUTOMOTORES" de una aseguradora argentina.
Te paso las paginas escaneadas o fotografiadas. La pagina 3, si esta, es el "ANEXO II Lesiones".

Reglas, en orden de importancia:
1. NO INVENTES NADA. Transcribi solo lo que esta escrito a mano. Si un dato no esta escrito, el campo va vacio ("").
2. Si un dato esta escrito pero no se lee con seguridad, escribi tu mejor lectura Y agrega el nombre del campo
   a "campos_dudosos". Si es totalmente ilegible, dejalo vacio y agregalo a "campos_dudosos".
3. Ignora las secciones 4 (DATOS DEL ASEGURADO) y 5 (DATOS DEL VEHICULO ASEGURADO), salvo el DOMINIO de la seccion 5,
   que va en "dominio_propio", y "Detalle los daños del vehiculo" de la seccion 5, que va en "danos_propios".
4. El formulario trae impreso "Provincia Buenos Aires" en la seccion 2: eso NO es un dato. Deduci la provincia de la
   localidad escrita a mano: "CABA" si es Capital Federal, CABA o un barrio porteño (Caballito, Flores, etc.);
   si no, "BUENOS AIRES" u otra provincia segun corresponda. "conductor_provincia" es la provincia escrita en la
   seccion 3 (por ejemplo BS AS = BUENOS AIRES).
5. Formatos:
   - fecha: AAAA-MM-DD (el año 26 es 2026). hora: HH:MM en formato 24 horas.
   - DNI, CUIT, telefonos, codigos postales: solo digitos, sin puntos, guiones ni espacios.
   - dominios (patentes): mayusculas, sin espacios ni guiones (ej. AB123CD o ABC123).
   - poliza: tal como esta escrita.
   - todo el texto en MAYUSCULAS.
   - nombres de personas: APELLIDO y despues NOMBRES, como esten escritos.
6. Seccion 6 (otro vehiculo): "tercero_propietario_*" son los datos del Propietario; "tercero_conductor_*" los del
   Conductor. Si dice que el conductor ES el propietario y los datos del conductor estan vacios, copia los del
   propietario en los del conductor. "tercero_conductor_es_propietario": "SI", "NO" o "" si no esta respondido.
7. "relato": el texto de DETALLES DEL SINIESTRO (seccion 8), completo, tal cual. "tercero_danos": "Detalle los daños
   del vehiculo" de la seccion 6.
8. "hubo_lesionados": "SI" solo si el ANEXO II tiene lesiones escritas; si esta tachado, vacio o no esta, "NO".
9. "campos_dudosos" lleva solo nombres de campos de este JSON.`;

function dominioLimpio(s: unknown): string {
    return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

Deno.serve(async (req: Request) => {
    const origen = req.headers.get("origin");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origen) });
    if (req.method !== "POST") return responder(origen, 405, { ok: false, error: "Método no permitido." });
    if (!clavePublicaValida(req)) return responder(origen, 401, { ok: false, error: "No autorizado." });
    const ia = clienteIA();
    if (!ia) return responder(origen, 503, { ok: false, error: "La lectura con IA todavía no está activada." });

    // ---- Lo que manda la pagina ----
    let cuerpo: { lectura_id?: string; dominio?: string; imagenes?: unknown };
    try {
        cuerpo = await req.json();
    } catch {
        return responder(origen, 400, { ok: false, error: "Pedido inválido." });
    }
    const lecturaId = String(cuerpo.lectura_id || "");
    const dominio = dominioLimpio(cuerpo.dominio);
    const imagenes = Array.isArray(cuerpo.imagenes) ? cuerpo.imagenes : [];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lecturaId) || !dominio) {
        return responder(origen, 400, { ok: false, error: "Pedido inválido." });
    }
    if (!imagenes.length || imagenes.length > MAX_PAGINAS
        || !imagenes.every((b) => typeof b === "string" && b.length > 1000 && b.length < MAX_BASE64_POR_PAGINA)) {
        return responder(origen, 400, { ok: false, error: `Mandá entre 1 y ${MAX_PAGINAS} fotos de la denuncia.` });
    }

    // ---- Controles y reserva de la lectura, todo junto para que dos pedidos
    //      simultaneos no se salteen el limite ----
    let reserva: { id: number; usadas: number } | { error: string; status: number };
    try {
        reserva = await sql.begin(async (tx) => {
            await tx`select pg_advisory_xact_lock(hashtext('lecturas_ia'))`;
            const [flota] = await tx`
                select 1 as ok from "Camiones"
                where upper(regexp_replace("DOMINIO", '[^A-Za-z0-9]', '', 'g')) = ${dominio} limit 1`;
            if (!flota) return { error: "La unidad no es de la flota.", status: 403 };
            const [{ usadas, intentos }] = await tx`
                select count(*) filter (where cuenta)::int as usadas, count(*)::int as intentos
                from privado.lecturas_ia where lectura_id = ${lecturaId}`;
            // Los intentos fallidos no gastan lectura, pero tienen su propio tope:
            // si no, un error que se repite podria consumir saldo sin fin
            if (usadas >= MAX_LECTURAS_POR_DENUNCIA || intentos >= MAX_INTENTOS_POR_DENUNCIA) {
                return { error: `Ya se usaron las ${MAX_LECTURAS_POR_DENUNCIA} lecturas de esta denuncia. Completala a mano.`, status: 429 };
            }
            // El tope del dia cuenta TODO, tambien los fallidos: es el que cuida el saldo
            const [{ hoy }] = await tx`
                select count(*)::int as hoy from privado.lecturas_ia
                where creado > now() - interval '24 hours'`;
            if (hoy >= MAX_LECTURAS_POR_DIA) {
                return { error: "Se alcanzó el máximo de lecturas del día. Completá la denuncia a mano.", status: 429 };
            }
            const [fila] = await tx`
                insert into privado.lecturas_ia (lectura_id, dominio, paginas)
                values (${lecturaId}, ${dominio}, ${imagenes.length}) returning id`;
            return { id: fila.id, usadas: usadas + 1 };
        });
    } catch (e) {
        console.error("reserva fallo:", e);
        return responder(origen, 500, { ok: false, error: "No se pudo consultar la base. Probá de nuevo." });
    }
    if ("error" in reserva) return responder(origen, reserva.status, { ok: false, error: reserva.error });

    // ---- La lectura ----
    const inicio = Date.now();
    const segundos = () => Math.round((Date.now() - inicio) / 100) / 10;
    try {
        const respuesta = await ia.messages.create({
            model: MODELO,
            max_tokens: 16000,   // Haiku piensa antes de responder: con 4096 se cortaba el JSON
            output_config: { format: { type: "json_schema", schema: ESQUEMA } },
            messages: [{
                role: "user",
                content: [
                    ...(imagenes as string[]).map((data) => ({
                        type: "image" as const,
                        source: { type: "base64" as const, media_type: "image/jpeg" as const, data },
                    })),
                    { type: "text" as const, text: INSTRUCCIONES },
                ],
            }],
        });

        const uso = respuesta.usage;
        if (respuesta.stop_reason !== "end_turn") {
            throw new Error(`la IA no terminó la respuesta (${respuesta.stop_reason})`);
        }
        const texto = respuesta.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        const datos = JSON.parse(texto);

        await sql`
            update privado.lecturas_ia set ok = true, segundos = ${segundos()},
                tokens_entrada = ${uso.input_tokens}, tokens_salida = ${uso.output_tokens}
            where id = ${reserva.id}`;
        return responder(origen, 200, {
            ok: true, datos,
            restantes: MAX_LECTURAS_POR_DENUNCIA - reserva.usadas,
        });

    } catch (e) {
        // Si la IA esta saturada o caida, o la clave vencio, la lectura no
        // cuenta: no es culpa de quien carga
        const status = e instanceof Anthropic.APIError ? e.status : undefined;
        const problemaDeClave = status === 401 || status === 403;
        const culpaDeLaIA = problemaDeClave || status === undefined || status === 429 || status >= 500;
        const motivo = e instanceof Error ? e.message : String(e);
        console.error("lectura fallo:", status, motivo);
        await sql`
            update privado.lecturas_ia set ok = false, cuenta = ${!culpaDeLaIA},
                segundos = ${segundos()}, error = ${motivo.slice(0, 500)}
            where id = ${reserva.id}`.catch(() => {});
        return responder(origen, 502, {
            ok: false,
            error: problemaDeClave
                ? "La lectura con IA no está disponible (problema con la clave). Completá la denuncia a mano y avisá a administración."
                : culpaDeLaIA
                    ? "La IA no respondió. Probá de nuevo en un minuto (no se descontó la lectura)."
                    : "La IA no pudo leer la denuncia. Probá con fotos más nítidas o completala a mano.",
            restantes: MAX_LECTURAS_POR_DENUNCIA - reserva.usadas + (culpaDeLaIA ? 1 : 0),
        });
    }
});
