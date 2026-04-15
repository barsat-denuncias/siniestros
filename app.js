const URL_API = "https://ojsjxyxvcznoydhzhsrt.supabase.co";
const KEY_API = "sb_publishable__4dVId8Vbc2lsHIZrhzoMA_sRnfpxuh";
const EMAILJS_SERVICE_ID = "service_snce9ja";
const EMAILJS_TEMPLATE_ID = "template_66ehu6p";
const EMAILJS_PUBLIC_KEY = "uYFGRrX_AbRYotS_Q";

let unidad = {};

window.onload = function() {
    // Bloqueo de fechas futuras
    const hoy = new Date().toISOString().split('T')[0];
    document.getElementById('fecha_hecho').setAttribute('max', hoy);
    emailjs.init(EMAILJS_PUBLIC_KEY);
    
    document.getElementById('es_propietario').addEventListener('change', function() {
        document.getElementById('datos_propietario').classList.toggle('hidden', this.value === 'SI');
    });
};

document.getElementById('form-validacion').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patente = document.getElementById('patente').value.trim().toUpperCase();
    const chasis = document.getElementById('chasis_val').value.trim();
    
    // USAMOS TUS COLUMNAS: DOMINIO, CHASIS, MODELO, VEHICULO
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

const titulos = ["", "Paso 1: El Hecho", "Paso 2: Conductor", "Paso 3: Daños y Relato", "Paso 4: El Tercero", "Paso 5: Fotos"];

function cambiarPaso(paso) {
    document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'));
    document.getElementById(`step-${paso}`).classList.remove('hidden');
    document.getElementById('progress').style.width = (paso * 20) + "%";
    document.getElementById('titulo-paso').innerText = titulos[paso]; // CORRECCIÓN TÍTULO
    window.scrollTo(0,0);
}

function validarYPasar(proximoPaso) {
    const inputs = document.getElementById(`step-${proximoPaso - 1}`).querySelectorAll('[required]');
    let valido = true;
    inputs.forEach(i => {
        // Validación solo números para DNI y Tel
        if(i.id.includes('dni') || i.id.includes('tel') || i.id === 'cp'){
            i.value = i.value.replace(/[^0-9]/g,'');
        }
        if(!i.checkValidity()){ i.style.borderColor = "red"; valido = false; } 
        else { i.style.borderColor = "#ddd"; }
    });
    if(valido) cambiarPaso(proximoPaso);
}

async function enviarSiniestro() {
    const btn = document.getElementById('btn-finalizar');
    btn.innerText = "Procesando..."; btn.disabled = true;
    const ts = Date.now();
    const folder = `${unidad.DOMINIO}_${ts}`;
    const val = (id) => document.getElementById(id).value.trim() || "NO INFORMA";

    try {
        // SUBIDA DE FOTOS (CATEGORIZADAS)
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

        // LLENAR PDF
        document.getElementById('p-fecha').innerText = val('fecha_hecho');
        document.getElementById('p-hora').innerText = val('hora_hecho');
        document.getElementById('p-cp').innerText = val('cp');
        document.getElementById('p-lugar').innerText = `${val('calle')} e/ ${val('interseccion')}, ${val('localidad')}, ${val('provincia')}`;
        document.getElementById('p-c-nom').innerText = val('nombre_chofer').toUpperCase();
        document.getElementById('p-c-dni').innerText = val('dni_chofer');
        document.getElementById('p-c-tel').innerText = val('tel_chofer');
        document.getElementById('p-c-dom').innerText = `${val('domicilio_chofer')}, ${val('loc_chofer')}, ${val('prov_chofer')}`;
        
        // DATOS AUTOMÁTICOS
        document.getElementById('p-v-do').innerText = unidad.DOMINIO;
        document.getElementById('p-v-mm').innerText = unidad.MODELO; // Marca/Modelo guardado en tu tabla
        document.getElementById('p-v-ti').innerText = unidad.VEHICULO; // Tipo (camion socio/utilitario)
        document.getElementById('p-v-ch').innerText = unidad.CHASIS;

        document.getElementById('p-v-dan').innerText = val('danos_propios');
        document.getElementById('p-t-do').innerText = val('patente_tercero').toUpperCase();
        document.getElementById('p-t-mm').innerText = val('marca_tercero').toUpperCase();
        document.getElementById('p-t-se').innerText = val('seguro_tercero').toUpperCase();
        document.getElementById('p-t-po').innerText = val('poliza_tercero');
        document.getElementById('p-t-da').innerText = val('danos_tercero');

        if(document.getElementById('es_propietario').value === 'NO'){
            document.getElementById('p-t-p-no').innerText = val('prop_nombre').toUpperCase();
            document.getElementById('p-t-p-dn').innerText = val('prop_dni');
            document.getElementById('p-t-p-te').innerText = val('prop_tel');
        } else { document.getElementById('p-t-p-no').innerText = val('nombre_chofer').toUpperCase(); }

        document.getElementById('p-relato').innerText = val('descripcion');
        document.getElementById('p-lista-fotos').innerHTML = links.map(l => `<p>${l}</p>`).join('');

        // GENERAR PDF
        await new Promise(r => setTimeout(r, 800));
        const pdfBlob = await html2pdf().set({ margin: 0, html2canvas: { scale: 2 } }).from(document.getElementById('pdf-template')).output('blob');
        const pdfPath = `${folder}/Denuncia_Oficial.pdf`;
        await fetch(`${URL_API}/storage/v1/object/denuncias/${pdfPath}`, {
            method: 'POST',
            headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': 'application/pdf' },
            body: pdfBlob
        });

        const linkFinal = `${URL_API}/storage/v1/object/public/denuncias/${pdfPath}`;
        
        // GUARDAR EN TABLA
        await fetch(`${URL_API}/rest/v1/Siniestros`, {
            method: 'POST',
            headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fecha_hecho: val('fecha_hecho'), nombre_chofer: val('nombre_chofer'), link_pdf: linkFinal, dominio_nuestro: unidad.DOMINIO })
        });

        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, { link_pdf: linkFinal, dominio: unidad.DOMINIO });
        alert("Denuncia cargada correctamente.");
        location.reload();
    } catch (e) { alert("Error: " + e.message); btn.disabled = false; btn.innerText = "Cargar Denuncia"; }
}