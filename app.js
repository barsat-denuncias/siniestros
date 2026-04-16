const URL_API = "https://ojsjxyxvcznoydhzhsrt.supabase.co";
const KEY_API = "sb_publishable__4dVId8Vbc2lsHIZrhzoMA_sRnfpxuh";
const EMAILJS_SERVICE_ID = "service_snce9ja";
const EMAILJS_TEMPLATE_ID = "template_66ehu6p";
const EMAILJS_PUBLIC_KEY = "uYFGRrX_AbRYotS_Q";

let unidad = {};
let datosEmpresa = {};
let nroSiniestroFinal = 100000; // Valor por defecto

const titulos = ["", "Paso 1: Lugar y Fecha", "Paso 2: Conductor", "Paso 3: Daños y Relato", "Paso 4: El Tercero", "Paso 5: Fotos"];

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

// BOTÓN DE VALIDACIÓN: BÚSQUEDA DOBLE
document.getElementById('form-validacion').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.innerText = "Buscando..."; btn.disabled = true;

    const patente = document.getElementById('patente').value.trim().toUpperCase();
    const chasis = document.getElementById('chasis_val').value.trim();

    try {
        // 1. Buscamos el camión
        const resUnidad = await fetch(`${URL_API}/rest/v1/Camiones?DOMINIO=eq.${patente}&CHASIS=like.*${chasis}`, {
            headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}` }
        });
        const dataU = await resUnidad.json();

        if (dataU.length > 0) {
            unidad = dataU[0];
            
            // 2. Buscamos la empresa vinculada (usando RAZON_SOCIAL del camión como clave)
            const resEmpresa = await fetch(`${URL_API}/rest/v1/Empresas?nombre_clave=eq.${unidad.RAZON_SOCIAL}`, {
                headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}` }
            });
            const dataE = await resEmpresa.json();
            if (dataE.length > 0) { datosEmpresa = dataE[0]; }

            // 3. Obtenemos el próximo número de siniestro
            const resSini = await fetch(`${URL_API}/rest/v1/Siniestros?select=nro_siniestro&order=nro_siniestro.desc&limit=1`, {
                headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}` }
            });
            const dataS = await resSini.json();
            if (dataS.length > 0 && dataS[0].nro_siniestro) {
                nroSiniestroFinal = parseInt(dataS[0].nro_siniestro) + 1;
            }

            document.getElementById('pantalla-validacion').classList.add('hidden');
            document.getElementById('pantalla-formulario').classList.remove('hidden');
        } else {
            alert("Unidad no encontrada. Verifique patente y chasis.");
        }
    } catch (err) {
        alert("Error de conexión: " + err.message);
    } finally {
        btn.innerText = "Validar Unidad"; btn.disabled = false;
    }
});

function cambiarPaso(paso) {
    document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'));
    document.getElementById(`step-${paso}`).classList.remove('hidden');
    document.getElementById('progress').style.width = (paso * 20) + "%";
    document.getElementById('titulo-paso').innerText = titulos[paso];
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
        const catLabels = { 'propios': 'daños', 'tercero': 'daños_terc', 'doc_cond': 'registro', 'doc_terc': 'registro_terc', 'otros': 'otros' };

        for (const c of cats) {
            const f = document.getElementById(`f_${c}`).files;
            for (let i = 0; i < f.length; i++) {
                const path = `${folder}/${c}_${i}.jpg`;
                await fetch(`${URL_API}/storage/v1/object/denuncias/${path}`, {
                    method: 'POST',
                    headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': f[i].type },
                    body: f[i]
                });
                links.push({ url: `${URL_API}/storage/v1/object/public/denuncias/${path}`, label: `${catLabels[c]}_${i+1}` });
            }
        }

        // POBLAR PDF CON DATOS AUTOMÁTICOS
        setVal('p-sini-id', nroSiniestroFinal);
        setVal('p-v-aseg', unidad.ASEGURADORA); 
        setVal('p-v-pol', unidad.POLIZA); 
        setVal('p-fecha', val('fecha_hecho'));
        setVal('p-hora', val('hora_hecho'));
        setVal('p-fecha-den', new Date().toLocaleDateString());
        setVal('p-cp', val('cp'));
        setVal('p-prov', val('provincia'));
        setVal('p-loc', val('localidad'));
        setVal('p-calle', val('calle'));
        setVal('p-int', val('interseccion'));
        
        // Datos Conductor
        setVal('p-c-nom', val('nombre_chofer'));
        setVal('p-c-dni', val('dni_chofer'));
        setVal('p-c-tel', val('tel_chofer'));
        setVal('p-c-dom', val('domicilio_chofer') + ", " + val('loc_chofer'));
        
        // SECCIÓN 4: DATOS DEL ASEGURADO (Desde tabla Empresas)
        setVal('p-aseg-razon', datosEmpresa.razon_social_completa);
        setVal('p-aseg-cuit', datosEmpresa.cuit);
        setVal('p-aseg-tel', datosEmpresa.telefono);
        setVal('p-aseg-dom', datosEmpresa.domicilio);
        setVal('p-aseg-cp', datosEmpresa.cp);

        // SECCIÓN 5: VEHÍCULO
        setVal('p-v-do', unidad.DOMINIO);
        setVal('p-v-ma', "MERCEDES BENZ"); // O unidad.VEHICULO
        setVal('p-v-mo', unidad.MODELO);
        setVal('p-v-ti', unidad.VEHICULO);
        setVal('p-v-cha', unidad.CHASIS);
        setVal('p-v-dan', val('danos_propios'));
        
        // SECCIÓN 7, 8 y 9
        setVal('p-7-lugar', val('localidad') + ", " + val('provincia'));
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
        
        // SECCIÓN 9: DENUNCIANTE (Automático)
        setVal('p-denun-nom', datosEmpresa.razon_social_completa);
        setVal('p-denun-genero', "Persona Jurídica");
        setVal('p-denun-doc', "CUIT " + datosEmpresa.cuit);
        setVal('p-denun-tel', datosEmpresa.telefono);
        setVal('p-denun-dom', datosEmpresa.domicilio);
        setVal('p-denun-cp', datosEmpresa.cp);
        setVal('p-denun-loc', datosEmpresa.localidad);
        setVal('p-denun-prov', datosEmpresa.provincia);

        const fotoContainer = document.getElementById('p-lista-fotos');
        if (fotoContainer) {
            fotoContainer.innerHTML = links.length > 0 
                ? links.map(l => `<a href="${l.url}" target="_blank" style="text-decoration:none; color:#444; margin-right:15px;">• ${l.label}</a>`).join(' ') 
                : "No se adjuntaron fotos.";
        }

        await new Promise(r => setTimeout(r, 1200)); 
        const opt = { margin: 0, filename: `Denuncia_${unidad.DOMINIO}.pdf`, html2canvas: { scale: 2, useCORS: true, scrollY: 0 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } };
        const pdfBlob = await html2pdf().set(opt).from(document.getElementById('pdf-template')).output('blob');

        const pdfPath = `${folder}/Denuncia_Final.pdf`;
        await fetch(`${URL_API}/storage/v1/object/denuncias/${pdfPath}`, { method: 'POST', headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': 'application/pdf' }, body: pdfBlob });
        const linkFinal = `${URL_API}/storage/v1/object/public/denuncias/${pdfPath}`;
        
        // GUARDAR EN BD (Incluyendo el nro_siniestro)
        await fetch(`${URL_API}/rest/v1/Siniestros`, { 
            method: 'POST', 
            headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ 
                fecha_hecho: val('fecha_hecho'), 
                nombre_chofer: val('nombre_chofer'), 
                link_pdf: linkFinal, 
                dominio_nuestro: unidad.DOMINIO,
                nro_siniestro: nroSiniestroFinal
            }) 
        });

        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, { link_pdf: linkFinal, dominio: unidad.DOMINIO });
        alert("¡ÉXITO! Denuncia cargada correctamente con el Nro: " + nroSiniestroFinal);
        location.reload();
    } catch (e) { alert("Error crítico: " + e.message); btn.disabled = false; btn.innerText = "Finalizar Denuncia"; }
}