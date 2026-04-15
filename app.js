const URL_API = "https://ojsjxyxvcznoydhzhsrt.supabase.co";
const KEY_API = "sb_publishable__4dVId8Vbc2lsHIZrhzoMA_sRnfpxuh";
const EMAILJS_SERVICE_ID = "service_snce9ja";
const EMAILJS_TEMPLATE_ID = "template_66ehu6p";
const EMAILJS_PUBLIC_KEY = "uYFGRrX_AbRYotS_Q";

let unidadInfo = {};

window.onload = function() {
    emailjs.init(EMAILJS_PUBLIC_KEY);
    
    // Toggle Propietario
    document.getElementById('es_propietario').addEventListener('change', function() {
        const div = document.getElementById('datos_propietario');
        if (this.value === 'NO') div.classList.remove('hidden');
        else div.classList.add('hidden');
    });
};

document.getElementById('form-validacion').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patente = document.getElementById('patente').value.trim().toUpperCase();
    const chasis = document.getElementById('chasis_val').value.trim();
    
    const res = await fetch(`${URL_API}/rest/v1/Camiones?DOMINIO=eq.${patente}&CHASIS=like.*${chasis}`, {
        headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}` }
    });
    const datos = await res.json();
    
    if (datos.length > 0) {
        unidadInfo = datos[0]; // Captura MARCA, MODELO, MOTOR, CHASIS
        document.getElementById('pantalla-validacion').classList.add('hidden');
        document.getElementById('pantalla-formulario').classList.remove('hidden');
    } else {
        document.getElementById('mensaje-error').innerText = "Unidad no encontrada.";
    }
});

const titulos = ["", "Paso 1: El Hecho", "Paso 2: Conductor", "Paso 3: Relato y Daños", "Paso 4: El Tercero", "Paso 5: Fotos"];

function cambiarPaso(paso) {
    document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'));
    document.getElementById(`step-${paso}`).classList.remove('hidden');
    document.getElementById('progress').style.width = (paso * 20) + "%";
    document.getElementById('titulo-paso').innerText = titulos[paso];
    window.scrollTo(0,0);
}

function validarYPasar(proximoPaso) {
    const inputs = document.getElementById(`step-${proximoPaso - 1}`).querySelectorAll('[required]');
    let valido = true;
    inputs.forEach(i => {
        if(!i.value || !i.checkValidity()){ i.style.borderColor = "red"; valido = false; } 
        else { i.style.borderColor = "#ddd"; }
    });
    if(valido) cambiarPaso(proximoPaso);
}

async function enviarSiniestro() {
    const btn = document.getElementById('btn-finalizar');
    const inputFotos = document.getElementById('input-fotos');
    if(inputFotos.files.length === 0) return alert("Suba al menos una foto.");

    btn.innerText = "Procesando..."; btn.disabled = true;
    const ts = Date.now();
    const folder = `${unidadInfo.DOMINIO}_${ts}`;
    const val = (id) => document.getElementById(id).value.trim() || "NO INFORMA";

    try {
        // 1. SUBIR FOTOS
        const links = [];
        for (let i = 0; i < inputFotos.files.length; i++) {
            const f = inputFotos.files[i];
            const path = `${folder}/foto_${i}.jpg`;
            await fetch(`${URL_API}/storage/v1/object/denuncias/${path}`, {
                method: 'POST',
                headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': f.type },
                body: f
            });
            links.push(`${URL_API}/storage/v1/object/public/denuncias/${path}`);
        }

        // 2. LLENAR PDF (3 PÁGINAS)
        document.getElementById('p-fecha').innerText = val('fecha_hecho');
        document.getElementById('p-hora').innerText = val('hora_hecho');
        document.getElementById('p-cp').innerText = val('cp');
        document.getElementById('p-prov').innerText = val('provincia');
        document.getElementById('p-loc').innerText = val('localidad');
        document.getElementById('p-calle').innerText = val('calle');
        document.getElementById('p-int').innerText = val('interseccion');

        document.getElementById('p-c-nom').innerText = val('nombre_chofer');
        document.getElementById('p-c-dni').innerText = val('dni_chofer');
        document.getElementById('p-c-tel').innerText = val('tel_chofer');
        document.getElementById('p-c-dom').innerText = val('domicilio_chofer');
        document.getElementById('p-c-loc').innerText = val('loc_chofer');
        document.getElementById('p-c-pr').innerText = val('prov_chofer');

        document.getElementById('p-v-do').innerText = unidadInfo.DOMINIO;
        document.getElementById('p-v-ma').innerText = unidadInfo.MARCA;
        document.getElementById('p-v-mo').innerText = unidadInfo.MODELO;
        document.getElementById('p-v-mot').innerText = unidadInfo.N_MOTOR || "S/D";
        document.getElementById('p-v-cha').innerText = unidadInfo.CHASIS || "S/D";
        document.getElementById('p-v-dan').innerText = val('danos_propios');

        document.getElementById('p-t-do').innerText = val('patente_tercero');
        document.getElementById('p-t-mm').innerText = val('marca_tercero');
        document.getElementById('p-t-se').innerText = val('seguro_tercero');
        document.getElementById('p-t-po').innerText = val('poliza_tercero');
        document.getElementById('p-t-es').innerText = document.getElementById('es_propietario').value;
        document.getElementById('p-t-dan').innerText = val('danos_tercero');

        if(document.getElementById('es_propietario').value === 'NO'){
            document.getElementById('p-t-p-no').innerText = val('prop_nombre');
            document.getElementById('p-t-p-dn').innerText = val('prop_dni');
            document.getElementById('p-t-p-te').innerText = val('prop_tel');
        } else { document.getElementById('p-t-p-no').innerText = "EL CONDUCTOR"; }

        document.getElementById('p-relato').innerText = val('descripcion');
        document.getElementById('p-lista-fotos').innerHTML = links.map(l => `<p>${l}</p>`).join('');

        // 3. GENERAR Y SUBIR PDF
        await new Promise(r => setTimeout(r, 600));
        const pdfBlob = await html2pdf().set({ margin: 0, html2canvas: { scale: 2 } }).from(document.getElementById('pdf-template')).output('blob');
        const pdfPath = `${folder}/Denuncia_Oficial.pdf`;
        
        await fetch(`${URL_API}/storage/v1/object/denuncias/${pdfPath}`, {
            method: 'POST',
            headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': 'application/pdf' },
            body: pdfBlob
        });

        const link = `${URL_API}/storage/v1/object/public/denuncias/${pdfPath}`;
        
        // 4. GUARDAR EN SUPABASE
        await fetch(`${URL_API}/rest/v1/Siniestros`, {
            method: 'POST',
            headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fecha_hecho: val('fecha_hecho'),
                nombre_chofer: val('nombre_chofer'),
                link_pdf: link,
                dominio_nuestro: unidadInfo.DOMINIO
            })
        });

        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, { link_pdf: link, dominio: unidadInfo.DOMINIO });
        alert("Denuncia cargada correctamente.");
        location.reload();
    } catch (e) { alert("Error al procesar."); btn.disabled = false; }
}