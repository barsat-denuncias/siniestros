const URL_API = "https://ojsjxyxvcznoydhzhsrt.supabase.co";
const KEY_API = "sb_publishable__4dVId8Vbc2lsHIZrhzoMA_sRnfpxuh";
const EMAILJS_SERVICE_ID = "service_snce9ja";
const EMAILJS_TEMPLATE_ID = "template_66ehu6p";
const EMAILJS_PUBLIC_KEY = "uYFGRrX_AbRYotS_Q";

let unidad = {};

// Función auxiliar de seguridad para evitar el error de null
function setVal(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerText = text || "";
}

function aplicarValidacionEstricta(id) {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('input', () => {
        let val = input.value.toUpperCase();
        if (!"NO INFORMA".startsWith(val)) {
            input.value = val.replace(/[^0-9]/g, '');
        } else { input.value = val; }
    });
    input.addEventListener('blur', () => {
        let val = input.value.toUpperCase();
        if (val !== "" && val !== "NO INFORMA" && isNaN(val.replace(/\s/g,''))) {
            input.value = "";
            input.style.borderColor = "red";
        } else { input.style.borderColor = "#ddd"; }
    });
}

window.onload = function() {
    const hoy = new Date().toISOString().split('T')[0];
    document.getElementById('fecha_hecho').setAttribute('max', hoy);
    emailjs.init(EMAILJS_PUBLIC_KEY);
    ['dni_chofer', 'tel_chofer', 'prop_dni', 'prop_tel', 'cp'].forEach(aplicarValidacionEstricta);

    document.getElementById('es_propietario').addEventListener('change', function() {
        document.getElementById('datos_propietario').classList.toggle('hidden', this.value === 'SI');
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
        unidad = datos[0]; 
        document.getElementById('pantalla-validacion').classList.add('hidden');
        document.getElementById('pantalla-formulario').classList.remove('hidden');
    } else { document.getElementById('mensaje-error').innerText = "Unidad no encontrada."; }
});

function cambiarPaso(paso) {
    document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'));
    document.getElementById(`step-${paso}`).classList.remove('hidden');
    document.getElementById('progress').style.width = (paso * 20) + "%";
    const msg = document.getElementById('msg-obligatorio');
    if (paso === 5) msg.style.display = 'none';
    else msg.style.display = 'block';
    window.scrollTo(0,0);
}

function validarYPasar(proximoPaso) {
    const inputs = document.getElementById(`step-${proximoPaso - 1}`).querySelectorAll('[required]');
    let valido = true;
    inputs.forEach(i => {
        if(!i.checkValidity()){ i.style.borderColor = "red"; valido = false; } 
        else { i.style.borderColor = "#ddd"; }
    });
    if(valido) cambiarPaso(proximoPaso);
}

async function enviarSiniestro() {
    const btn = document.getElementById('btn-finalizar');
    btn.innerText = "Enviando..."; btn.disabled = true;
    const ts = Date.now();
    const folder = `${unidad.DOMINIO}_${ts}`;
    const val = (id) => document.getElementById(id) ? document.getElementById(id).value.trim().toUpperCase() : "NO INFORMA";

    try {
        const cats = ['propios', 'tercero', 'doc_cond', 'doc_terc', 'otros'];
        const links = [];
        for (const c of cats) {
            const f = document.getElementById(`f_${c}`).files;
            for (let i = 0; i < f.length; i++) {
                const path = `${folder}/${c}_${i}.jpg`;
                await fetch(`${URL_API}/storage/v1/object/denuncias/${path}`, {
                    method: 'POST',
                    headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': f[i].type },
                    body: f[i]
                });
                links.push(`${URL_API}/storage/v1/object/public/denuncias/${path}`);
            }
        }

        // POBLAR PDF USANDO ESCUDO DE SEGURIDAD
        setVal('p-sini-id', ts.toString().slice(-6));
        setVal('p-v-aseg', ""); 
        setVal('p-v-pol', ""); 
        setVal('p-fecha', val('fecha_hecho'));
        setVal('p-hora', val('hora_hecho'));
        setVal('p-fecha-den', new Date().toLocaleDateString());
        setVal('p-cp', val('cp'));
        setVal('p-prov', val('provincia'));
        setVal('p-loc', val('localidad'));
        setVal('p-calle', val('calle'));
        setVal('p-int', val('interseccion'));
        setVal('p-c-nom', val('nombre_chofer'));
        setVal('p-c-dni', val('dni_chofer'));
        setVal('p-c-tel', val('tel_chofer'));
        setVal('p-c-dom', val('domicilio_chofer') + ", " + val('loc_chofer') + ", " + val('prov_chofer'));
        
        setVal('p-v-do', unidad.DOMINIO);
        setVal('p-v-ma', "MERCEDES BENZ");
        setVal('p-v-mo', unidad.MODELO);
        setVal('p-v-ti', unidad.VEHICULO);
        setVal('p-v-cha', unidad.CHASIS);
        setVal('p-v-dan', val('danos_propios'));
        
        setVal('p-t-p-no', val('prop_nombre') || val('nombre_chofer'));
        setVal('p-t-p-dn', val('prop_dni'));
        setVal('p-t-p-te', val('prop_tel'));
        setVal('p-t-ma', val('marca_tercero'));
        setVal('p-t-mo', val('marca_tercero'));
        setVal('p-t-do', val('patente_tercero'));
        setVal('p-t-se', val('seguro_tercero'));
        setVal('p-t-po', val('poliza_tercero'));
        setVal('p-t-dan', val('danos_tercero'));
        setVal('p-relato', val('descripcion'));
        
        const fotoContainer = document.getElementById('p-lista-fotos');
        if (fotoContainer) {
            fotoContainer.innerHTML = links.length > 0 ? links.map(l => `<p>${l}</p>`).join('') : "<p>No se adjuntaron fotos.</p>";
        }

        await new Promise(r => setTimeout(r, 1200)); 
        const opt = { margin: 0, filename: `Denuncia_${unidad.DOMINIO}.pdf`, html2canvas: { scale: 2, useCORS: true, scrollY: 0 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } };
        const pdfBlob = await html2pdf().set(opt).from(document.getElementById('pdf-template')).output('blob');

        const pdfPath = `${folder}/Denuncia_Final.pdf`;
        await fetch(`${URL_API}/storage/v1/object/denuncias/${pdfPath}`, { method: 'POST', headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': 'application/pdf' }, body: pdfBlob });
        const linkFinal = `${URL_API}/storage/v1/object/public/denuncias/${pdfPath}`;
        await fetch(`${URL_API}/rest/v1/Siniestros`, { method: 'POST', headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fecha_hecho: val('fecha_hecho'), nombre_chofer: val('nombre_chofer'), link_pdf: linkFinal, dominio_nuestro: unidad.DOMINIO }) });
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, { link_pdf: linkFinal, dominio: unidad.DOMINIO });
        alert("¡ÉXITO! Denuncia cargada correctamente.");
        location.reload();
    } catch (e) { alert("Error crítico: " + e.message); btn.disabled = false; btn.innerText = "Finalizar Denuncia"; }
}