const URL_API = "https://ojsjxyxvcznoydhzhsrt.supabase.co";
const KEY_API = "sb_publishable__4dVId8Vbc2lsHIZrhzoMA_sRnfpxuh";
const EMAILJS_SERVICE_ID = "service_snce9ja";
const EMAILJS_TEMPLATE_ID = "template_66ehu6p";
const EMAILJS_PUBLIC_KEY = "uYFGRrX_AbRYotS_Q";

let unidad = {};
let datosEmpresa = {};
let nroSiniestroFinal = "SN1"; 

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

document.getElementById('form-validacion').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.innerText = "Buscando..."; btn.disabled = true;
    const patente = document.getElementById('patente').value.trim().toUpperCase();
    const chasis = document.getElementById('chasis_val').value.trim();

    try {
        const resU = await fetch(`${URL_API}/rest/v1/Camiones?DOMINIO=eq.${patente}&CHASIS=like.*${chasis}`, {
            headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}` }
        });
        const dataU = await resU.json();

        if (dataU.length > 0) {
            unidad = dataU[0];
            const claveEmpresa = unidad.RAZON_SOCIAL.toUpperCase().trim(); 

            const resE = await fetch(`${URL_API}/rest/v1/Empresas?nombre_clave=eq.${claveEmpresa}`, {
                headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}` }
            });
            const dataE = await resE.json();
            if (dataE.length > 0) {
                datosEmpresa = dataE[0];
            } else { datosEmpresa = {}; }

            // LÓGICA SN: BUSCA EL ÚLTIMO ID CARGADO PARA SUMAR +1
            const resS = await fetch(`${URL_API}/rest/v1/Siniestros?select=nro_siniestro&order=id.desc&limit=1`, {
                headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}` }
            });
            const dataS = await resS.json();
            if (dataS.length > 0 && dataS[0].nro_siniestro) {
                const lastVal = String(dataS[0].nro_siniestro);
                const numericPart = parseInt(lastVal.replace('SN', '')) || 0;
                nroSiniestroFinal = `SN${numericPart + 1}`;
            } else { nroSiniestroFinal = "SN1"; }

            document.getElementById('pantalla-validacion').classList.add('hidden');
            document.getElementById('pantalla-formulario').classList.remove('hidden');
        } else { alert("Unidad no encontrada."); }
    } catch (err) { alert("Error: " + err.message); }
    finally { btn.innerText = "Validar Unidad"; btn.disabled = false; }
});

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

        // LLENAR PDF
        setVal('p-sini-id', nroSiniestroFinal);
        setVal('p-v-aseg', unidad.ASEGURADORA); setVal('p-v-pol', unidad.POLIZA); 
        setVal('p-fecha', val('fecha_hecho')); setVal('p-hora', val('hora_hecho'));
        setVal('p-fecha-den', new Date().toLocaleDateString());
        setVal('p-loc', val('localidad')); setVal('p-prov', val('provincia'));
        setVal('p-calle', val('calle')); setVal('p-int', val('interseccion'));
        
        setVal('p-aseg-razon', datosEmpresa.razon_social_completa || unidad.RAZON_SOCIAL);
        setVal('p-aseg-cuit', datosEmpresa.cuit); setVal('p-aseg-tel', datosEmpresa.telefono);
        setVal('p-aseg-dom', datosEmpresa.domicilio); setVal('p-aseg-cp', datosEmpresa.cp);

        let m = unidad.MODELO || "";
        let marcaFinal = (m.includes("MERCEDES") || m.includes("BENZ")) ? "MERCEDES BENZ" : (m.includes("CITROEN") ? "CITROEN" : m.split(' ')[0]);
        setVal('p-v-ma', marcaFinal); setVal('p-v-mo', m);
        setVal('p-v-do', unidad.DOMINIO); setVal('p-v-anio', unidad.ANIO);
        setVal('p-v-mot', unidad.MOTOR); setVal('p-v-cha', unidad.CHASIS);
        setVal('p-v-dan', val('danos_propios')); setVal('p-relato', val('descripcion'));
        
        setVal('p-c-nom', val('nombre_chofer')); setVal('p-c-dni', val('dni_chofer'));
        setVal('p-c-tel', val('tel_chofer')); setVal('p-c-dom', val('domicilio_chofer') + ", " + val('loc_chofer'));
        
        setVal('p-t-p-no', val('prop_nombre') || val('nombre_chofer'));
        setVal('p-t-p-dn', val('prop_dni')); setVal('p-t-ma', val('marca_tercero'));
        setVal('p-t-mo', val('marca_tercero')); setVal('p-t-do', val('patente_tercero'));
        setVal('p-t-se', val('seguro_tercero')); setVal('p-t-po', val('poliza_tercero'));
        setVal('p-t-dan', val('danos_tercero'));

        const fotoContainer = document.getElementById('p-lista-fotos');
        if (fotoContainer) {
            fotoContainer.innerHTML = links.map(l => `<a href="${l.url}" target="_blank" style="text-decoration:none; color:#444; margin-right:15px;">• ${l.label}</a>`).join(' ');
        }

        await new Promise(r => setTimeout(r, 1200)); 
        const opt = { margin: 0, filename: `Denuncia_${unidad.DOMINIO}.pdf`, html2canvas: { scale: 2, useCORS: true, scrollY: 0 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } };
        const pdfBlob = await html2pdf().set(opt).from(document.getElementById('pdf-template')).output('blob');

        const pdfPath = `${folder}/Denuncia_Final.pdf`;
        await fetch(`${URL_API}/storage/v1/object/denuncias/${pdfPath}`, { method: 'POST', headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': 'application/pdf' }, body: pdfBlob });
        const linkFinal = `${URL_API}/storage/v1/object/public/denuncias/${pdfPath}`;
        
        // ENVIO COMPLETO A TABLA SINIESTROS
        await fetch(`${URL_API}/rest/v1/Siniestros`, { 
            method: 'POST', 
            headers: { 'apikey': KEY_API, 'Authorization': `Bearer ${KEY_API}`, 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ 
                fecha_hecho: val('fecha_hecho'), 
                hora_hecho: val('hora_hecho'),
                nombre_chofer: val('nombre_chofer'), 
                dni_chofer: val('dni_chofer'),
                tel_chofer: val('tel_chofer'),
                domicilio_chofer: val('domicilio_chofer'),
                link_pdf: linkFinal, 
                nro_siniestro: nroSiniestroFinal,
                danos_propios: val('danos_propios'),
                relato: val('descripcion'),
                patente_tercero: val('patente_tercero'),
                marca_tercero: val('marca_tercero'),
                seguro_tercero: val('seguro_tercero'),
                poliza_tercero: val('poliza_tercero'),
                danos_tercero: val('danos_tercero'),
                prop_nombre: val('prop_nombre'),
                prop_dni: val('prop_dni'),
                prop_tel: val('prop_tel'),
                provincia: val('provincia'),
                localidad: val('localidad'),
                cp: val('cp'),
                calle_interseccion: `${val('calle')} e ${val('interseccion')}`
            }) 
        });

        // ENVIO DE MAIL RESTAURADO
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, { link_pdf: linkFinal, dominio: unidad.DOMINIO });

        alert("¡ÉXITO! Denuncia cargada: " + nroSiniestroFinal);
        location.reload();
    } catch (e) { alert("Error: " + e.message); btn.disabled = false; btn.innerText = "Finalizar Denuncia"; }
}