import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  LayoutDashboard, Briefcase, Users, Package, Landmark, ArrowLeftRight,
  ClipboardList, Plus, X, Check, Trash2, Loader2, Settings, Camera, ImageOff, Printer, Receipt, Sparkles, PenLine, Download, ShieldAlert, CalendarDays, Tag, Building2, Phone, Mail, Hash, Lock, Unlock, MapPin
} from "lucide-react";
import { db, storage } from "./firebase";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { ref, uploadString, getDownloadURL } from "firebase/storage";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Convierte una dirección de texto en coordenadas (lat/lng) usando el servicio gratuito de OpenStreetMap.
// No requiere llave/API key. Se usa solo la primera vez por trabajo; luego las coordenadas se guardan.
async function geocodificarDireccion(direccion) {
  // Intento 1: Censo de EE.UU. — gratis, sin llave, y normalmente más preciso con direcciones de EE.UU.
  try {
    const url1 = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(direccion)}&benchmark=Public_AR_Current&format=json`;
    const res1 = await fetch(url1);
    const data1 = await res1.json();
    const match = data1?.result?.addressMatches?.[0];
    if (match?.coordinates) {
      return { lat: parseFloat(match.coordinates.y), lng: parseFloat(match.coordinates.x) };
    }
  } catch {}
  // Intento 2 (respaldo): OpenStreetMap, con sesgo a Estados Unidos
  try {
    const url2 = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(direccion)}`;
    const res2 = await fetch(url2, { headers: { Accept: "application/json" } });
    const data2 = await res2.json();
    if (data2 && data2[0]) {
      return { lat: parseFloat(data2[0].lat), lng: parseFloat(data2[0].lon) };
    }
  } catch {}
  return null;
}

// Intenta sacar latitud/longitud de un link de Google Maps, o de un par de coordenadas pegado directo (ej. "33.749, -84.388")
function extraerCoordsDeLinkMaps(texto) {
  if (!texto) return null;
  const patrones = [
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,        // .../@33.749,-84.388,17z
    /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,   // ?q=33.749,-84.388
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,    // formato interno !3d..!4d..
    /(-?\d{1,3}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/, // coordenadas sueltas: 33.749, -84.388
  ];
  for (const p of patrones) {
    const m = texto.match(p);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  }
  return null;
}


// Sube una foto (en formato dataURL, como la que da compressImage) a Firebase Storage
// y devuelve el link público cortito — así el documento principal de la app nunca se llena,
// sin importar cuántas fotos se suban. Si algo falla, devuelve la foto tal cual (dataURL)
// como respaldo, para no perder el trabajo del usuario.
async function subirFoto(dataUrl) {
  try {
    const nombre = `fotos/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    const fotoRef = ref(storage, nombre);
    await uploadString(fotoRef, dataUrl, "data_url");
    return await getDownloadURL(fotoRef);
  } catch (e) {
    console.error("No se pudo subir la foto a Storage, se guarda localmente como respaldo", e);
    return dataUrl;
  }
}

const DOC_REF_PATH = ["app", "data"];

// Contraseña para poder EDITAR la aplicación. Sin ella, cualquiera que abra el link puede ver
// todo pero no se guarda nada si intenta agregar, editar o borrar algo — así los socios pueden
// consultar la información sin arriesgarse a borrar algo por accidente.
const CLAVE_EDICION = "MBServices2026";
const CLAVE_STORAGE_KEY = "mb-services-desbloqueado";

const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => new Date().toISOString().slice(0, 10);
const money = (n) =>
  (n < 0 ? "-$" : "$") +
  Math.abs(n || 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

// Comprime la foto de la factura antes de guardarla (para que quepa en el almacenamiento)
function compressImage(file, maxWidth = 700, quality = 0.45) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Le pide a la IA que lea la(s) foto(s) de la factura y devuelva los renglones estructurados.
// Acepta un arreglo de fotos (dataURL) por si la factura tiene varias hojas — se leen juntas como una sola.
async function extraerFacturaConIA(dataUrls) {
  const fotos = Array.isArray(dataUrls) ? dataUrls : [dataUrls];
  const images = fotos.map((d) => d.split(",")[1]);
  const response = await fetch("/api/scan-invoice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ images }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || "Error de la IA");
  if (!Array.isArray(data.items)) throw new Error("Formato inesperado");
  return data;
}

// Descarga todos los datos como archivo JSON — tu copia de seguridad, independiente de Claude
function descargarRespaldo(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const fecha = todayISO();
  const nombre = (data.empresaNombre || "respaldo").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  a.download = `${nombre}-respaldo-${fecha}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const emptyData = () => ({
  socios: [
    { id: "s1", nombre: "Boris" },
    { id: "s2", nombre: "David" },
  ],
  empresaNombre: "MB Services",
  cuentas: [],
  trabajos: [],
  empleados: [],
  materiales: [],
  bitacora: [],
  clientes: [],
  nomina: [],
  ingresos: [],
  transferencias: [],
  reportes: [],
  rotacionNomina: { activa: false, socioInicioId: "s1", mesInicio: todayISO().slice(0, 7) },
});

// Convierte actividades guardadas con el formato viejo (empleadoIds/socioIds/extras/estado/nominaId)
// al nuevo formato (participantes con estado individual, nominaIds en plural). No toca las que ya migraron.
function migrarBitacora(bitacora) {
  if (!Array.isArray(bitacora)) return [];
  return bitacora.map((b) => {
    if (b.participantes) return b; // ya está en el formato nuevo
    const estadoViejo = b.estado === "completado" ? "completado" : "pendiente";
    const participantes = [
      ...(b.socioIds || []).map((ref) => ({ tipo: "socio", ref, estado: estadoViejo })),
      ...(b.empleadoIds || []).map((ref) => ({ tipo: "empleado", ref, estado: estadoViejo })),
      ...(b.extras || []).map((ref) => ({ tipo: "extra", ref, estado: estadoViejo })),
    ];
    return {
      ...b,
      participantes,
      nominaIds: b.nominaId ? [b.nominaId] : (b.nominaIds || []),
    };
  });
}

function useLedgerData() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    const ref = doc(db, ...DOC_REF_PATH);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const raw = { ...emptyData(), ...snap.data() };
          setData({ ...raw, bitacora: migrarBitacora(raw.bitacora) });
        } else {
          setData(emptyData());
        }
        setStatus("ready");
      },
      (e) => {
        setData(emptyData());
        setStatus("ready");
      }
    );
    return () => unsub();
  }, []);

  const persist = useCallback(async (next) => {
    setData(next);
    setStatus("saving");
    try {
      const ref = doc(db, ...DOC_REF_PATH);
      await setDoc(ref, next);
      setStatus("ready");
    } catch (e) {
      setStatus("error");
    }
  }, []);

  return { data, status, persist };
}

const TABS = [
  { id: "dashboard", label: "Resumen", icon: LayoutDashboard },
  { id: "trabajos", label: "Trabajos", icon: Briefcase },
  { id: "clientes", label: "Clientes", icon: Building2 },
  { id: "bitacora", label: "Actividad diaria", icon: CalendarDays },
  { id: "nomina", label: "Nómina", icon: Users },
  { id: "materiales", label: "Materiales", icon: Package },
  { id: "cuentas", label: "Cuentas", icon: Landmark },
  { id: "reembolsos", label: "Reembolsos", icon: ArrowLeftRight },
  { id: "reportes", label: "Reportes de cierre", icon: ClipboardList },
];

export default function App() {
  const { data, status, persist } = useLedgerData();
  const [tab, setTab] = useState("dashboard");
  const [showSocios, setShowSocios] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const [desbloqueado, setDesbloqueado] = useState(() => {
    try { return localStorage.getItem(CLAVE_STORAGE_KEY) === "si"; } catch (e) { return false; }
  });
  const [showClave, setShowClave] = useState(false);
  const [claveInput, setClaveInput] = useState("");
  const [claveError, setClaveError] = useState(false);
  const [avisoSoloLectura, setAvisoSoloLectura] = useState(false);

  if (!data) {
    return (
      <div style={{ background: PAPER }} className="min-h-screen flex items-center justify-center">
        <Loader2 className="animate-spin text-stone-500" size={28} />
      </div>
    );
  }

  const desbloquear = () => {
    const claveGuardada = data.claveEdicion || CLAVE_EDICION;
    if (claveInput === claveGuardada) {
      setDesbloqueado(true);
      setShowClave(false);
      setClaveInput("");
      setClaveError(false);
      try { localStorage.setItem(CLAVE_STORAGE_KEY, "si"); } catch (e) {}
    } else {
      setClaveError(true);
    }
  };

  const bloquear = () => {
    setDesbloqueado(false);
    try { localStorage.removeItem(CLAVE_STORAGE_KEY); } catch (e) {}
  };

  const update = (fn) => {
    if (!desbloqueado) {
      setAvisoSoloLectura(true);
      setTimeout(() => setAvisoSoloLectura(false), 2500);
      return;
    }
    const next = structuredClone ? structuredClone(data) : JSON.parse(JSON.stringify(data));
    fn(next);
    persist(next);
  };

  return (
    <div style={{ background: PAPER, fontFamily: "Inter, sans-serif" }} className="min-h-screen text-[#1E2A38]">
      <FontImport />

      {/* Header */}
      <header
        style={{ background: INK, borderBottom: `4px double ${AMBER}` }}
        className="px-4 sm:px-6 py-4 flex items-center justify-between sticky top-0 z-30"
      >
        <div>
          <div
            style={{ fontFamily: "'Special Elite', monospace", letterSpacing: "0.03em" }}
            className="text-[#F3EEE4] text-lg sm:text-xl"
          >
            {data.empresaNombre || "LIBRO MAYOR"}
          </div>
          <div className="text-[#C9C1B0] text-[11px] tracking-widest uppercase">
            Administración &amp; Contabilidad
          </div>
        </div>
        <div className="flex items-center gap-3">
          <SaveIndicator status={status} />
          <button
            onClick={() => (desbloqueado ? bloquear() : setShowClave(true))}
            className="text-[#C9C1B0] hover:text-white transition-colors"
            title={desbloqueado ? "Modo edición activo — toca para bloquear" : "Modo solo lectura — toca para desbloquear edición"}
          >
            {desbloqueado ? <Unlock size={18} /> : <Lock size={18} />}
          </button>
          <button
            onClick={() => setShowSocios(true)}
            className="text-[#C9C1B0] hover:text-white transition-colors"
            title="Configurar socios"
          >
            <Settings size={18} />
          </button>
        </div>
      </header>

      {!desbloqueado && (
        <div className="text-center text-[11px] py-1.5" style={{ background: "#FBF3E3", color: "#8A6416" }}>
          Modo solo lectura — toca el candado arriba para poder editar
        </div>
      )}

      {avisoSoloLectura && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 text-sm text-white" style={{ background: "#A13D2E" }}>
          Estás en modo solo lectura, no se guardó el cambio. Toca el candado para desbloquear.
        </div>
      )}

      {showClave && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setShowClave(false)}>
          <div className="bg-white max-w-xs w-full p-5" onClick={(e) => e.stopPropagation()}>
            <div className="stamp text-[14px] mb-3">Desbloquear edición</div>
            <input
              type="password"
              className="ledger-input mb-2"
              placeholder="Contraseña"
              value={claveInput}
              onChange={(e) => { setClaveInput(e.target.value); setClaveError(false); }}
              onKeyDown={(e) => e.key === "Enter" && desbloquear()}
              autoFocus
            />
            {claveError && <p className="text-[12px] mb-2" style={{ color: "#A13D2E" }}>Contraseña incorrecta.</p>}
            <div className="flex gap-2">
              <button className="btn-primary" onClick={desbloquear}><Check size={14} /> Entrar</button>
              <button className="text-sm text-[#7A7263] px-2" onClick={() => setShowClave(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs - folder style */}
      <nav className="flex overflow-x-auto no-scrollbar" style={{ background: "#E8E1D3" }}>
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                background: active ? PAPER : "transparent",
                borderTop: active ? `3px solid ${AMBER}` : "3px solid transparent",
                borderRight: "1px solid #D8D0BE",
                fontFamily: "'Special Elite', monospace",
              }}
              className={`shrink-0 px-4 py-3 text-[12px] sm:text-[13px] flex items-center gap-2 uppercase tracking-wide transition-colors ${
                active ? "text-[#1E2A38]" : "text-[#7A7263] hover:text-[#1E2A38]"
              }`}
            >
              <Icon size={15} />
              {t.label}
            </button>
          );
        })}
      </nav>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-16">
        {tab === "dashboard" && <Dashboard data={data} />}
        {tab === "trabajos" && <Trabajos data={data} update={update} onViewPhoto={setLightbox} />}
        {tab === "clientes" && <Clientes data={data} update={update} />}
        {tab === "bitacora" && <Bitacora data={data} update={update} />}
        {tab === "nomina" && <Nomina data={data} update={update} />}
        {tab === "materiales" && <Materiales data={data} update={update} onViewPhoto={setLightbox} />}
        {tab === "cuentas" && <Cuentas data={data} update={update} onViewPhoto={setLightbox} />}
        {tab === "reembolsos" && <Reembolsos data={data} update={update} />}
        {tab === "reportes" && <Reportes data={data} update={update} />}
      </main>

      {showSocios && <SociosModal data={data} update={update} onClose={() => setShowSocios(false)} />}

      {lightbox && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="Factura" className="max-w-full max-h-full object-contain" />
          <button className="absolute top-4 right-4 text-white" onClick={() => setLightbox(null)}><X size={26} /></button>
        </div>
      )}
    </div>
  );
}

/* ---------------- design tokens ---------------- */
const PAPER = "#F3EEE4";
const INK = "#1E2A38";
const AMBER = "#C1783C";
const GREEN = "#3B6E52";
const RED = "#A13D2E";
const LINE = "#C9C1B0";

function FontImport() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Special+Elite&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
      .no-scrollbar::-webkit-scrollbar{display:none}
      .no-scrollbar{-ms-overflow-style:none;scrollbar-width:none}
      .mono{font-family:'JetBrains Mono',monospace}
      .ledger-input{background:#fff;border:1px solid ${LINE};padding:8px 10px;font-size:14px;width:100%}
      .ledger-input:focus{outline:none;border-color:${AMBER}}
      .btn-primary{background:${INK};color:#F3EEE4;padding:9px 16px;font-size:13px;display:inline-flex;align-items:center;gap:6px;letter-spacing:.02em}
      .btn-primary:hover{background:#12202c}
      .card{background:#fff;border:1px solid ${LINE};position:relative}
      .stamp{font-family:'Special Elite',monospace;letter-spacing:.08em}
      .recibo-linea{border-bottom:2px dashed #333;margin:20px 0}
      @media print {
        body * { visibility: hidden; }
        #recibo-print, #recibo-print * { visibility: visible; }
        #recibo-print { position: absolute; top: 0; left: 0; width: 100%; }
        .no-print { display: none !important; }
      }
    `}</style>
  );
}

function SaveIndicator({ status }) {
  if (status === "saving")
    return <span className="text-[10px] text-[#C9C1B0] flex items-center gap-1"><Loader2 size={11} className="animate-spin" />guardando</span>;
  if (status === "error")
    return <span className="text-[10px] text-red-300">error al guardar</span>;
  return <span className="text-[10px] text-[#6B7D6F] flex items-center gap-1"><Check size={11} />guardado</span>;
}

function SectionTitle({ children, sub }) {
  return (
    <div className="mb-5">
      <h2 style={{ fontFamily: "'Special Elite', monospace" }} className="text-xl text-[#1E2A38]">
        {children}
      </h2>
      {sub && <p className="text-[13px] text-[#7A7263] mt-0.5">{sub}</p>}
      <div style={{ borderBottom: `1px dashed ${LINE}` }} className="mt-2" />
    </div>
  );
}

/* ---------------- calculations ---------------- */
// El monto real de un material, restando lo que se haya devuelto (si aplica)
function materialNeto(m) {
  return Number(m.monto || 0) - Number(m.montoDevuelto || 0);
}

function calcTrabajo(t, data) {
  // Los materiales que pagó directamente el cliente no cuentan como gasto nuestro
  const materialesPropios = data.materiales.filter((m) => m.trabajoId === t.id && m.pagadoPor !== "cliente");
  const materialesCliente = data.materiales.filter((m) => m.trabajoId === t.id && m.pagadoPor === "cliente");
  const materiales = materialesPropios.reduce((s, m) => s + materialNeto(m), 0);
  const materialesAportadosPorCliente = materialesCliente.reduce((s, m) => s + materialNeto(m), 0);
  const nominaItems = data.nomina.filter((n) => n.trabajoId === t.id);
  const manoDeObra = nominaItems.reduce((s, n) => s + Number(n.monto), 0);
  const manoDeObraPagada = nominaItems.filter((n) => n.estado !== "pendiente").reduce((s, n) => s + Number(n.monto), 0);
  const manoDeObraPendiente = nominaItems.filter((n) => n.estado === "pendiente").reduce((s, n) => s + Number(n.monto), 0);

  // Desglose de gastos por quién pagó cada cosa (ej. "Boris · Materiales", "David · Materiales")
  const desgloseMap = {};
  const acumular = (item, tipoLabel, montoOverride) => {
    const key = (item.pagadoPor || "empresa") + "|" + tipoLabel;
    if (!desgloseMap[key]) desgloseMap[key] = { nombre: pagadorNombre(data, item.pagadoPor), tipoLabel, monto: 0 };
    desgloseMap[key].monto += montoOverride !== undefined ? montoOverride : Number(item.monto);
  };
  materialesPropios.forEach((m) => acumular(m, "Materiales", materialNeto(m)));
  nominaItems.forEach((n) => acumular(n, "Nómina"));
  const desglose = Object.values(desgloseMap).sort((a, b) => a.nombre.localeCompare(b.nombre) || a.tipoLabel.localeCompare(b.tipoLabel));

  // Cuánto reembolsarle a cada persona, separado por materiales y por nómina — no incluye lo que puso
  // la empresa (a la empresa no hay que reembolsarle) ni lo que puso el cliente.
  const reembolsoMap = {};
  const acumularReembolso = (item, tipoLabel, montoOverride) => {
    const pagador = item.pagadoPor || "empresa";
    if (pagador === "empresa" || pagador === "cliente" || pagador === "sindefinir") return;
    const key = pagador + "|" + tipoLabel;
    if (!reembolsoMap[key]) reembolsoMap[key] = { pagadorId: pagador, nombre: pagadorNombre(data, pagador), tipoLabel, monto: 0 };
    reembolsoMap[key].monto += montoOverride !== undefined ? montoOverride : Number(item.monto);
  };
  materialesPropios.forEach((m) => acumularReembolso(m, "materiales", materialNeto(m)));
  nominaItems.forEach((n) => acumularReembolso(n, "nómina"));
  const reembolsoPorPersona = Object.values(reembolsoMap).sort((a, b) => a.nombre.localeCompare(b.nombre) || a.tipoLabel.localeCompare(b.tipoLabel));
  const totalReembolsosTrabajo = reembolsoPorPersona.reduce((s, r) => s + r.monto, 0);
  // Cuánto se le debe reembolsar a un socio específico en este trabajo (suma materiales + nómina)
  const reembolsoDeSocio = (socioId) => reembolsoPorPersona.filter((r) => r.pagadorId === socioId).reduce((s, r) => s + r.monto, 0);

  // El estimado se descuenta automáticamente por lo que el cliente ya compró directo (con su propio dinero).
  // Ejemplo: estimado $12,000, el cliente compró $3,000 en materiales por su cuenta → el estimado ajustado queda en $9,000.
  const estimadoAjustado = Number(t.estimado || 0) - materialesAportadosPorCliente;
  const ganancia = estimadoAjustado - materiales - manoDeObra;
  // Si ya se sabe cuánto pagó realmente el cliente, ese número YA viene neto (sin los materiales que compró él mismo),
  // así que no se le vuelve a restar materialesAportadosPorCliente — se usa tal cual.
  const tienePagoReal = t.estimadoPagado !== undefined && t.estimadoPagado !== null && t.estimadoPagado !== "";
  // Igual que con el Estimado, al "Estimado pagado" también se le resta lo que el cliente compró directo —
  // así no tienes que hacer esa resta tú misma antes de escribirlo, escribes el número completo tal cual.
  const estimadoPagadoAjustado = tienePagoReal ? Number(t.estimadoPagado || 0) - materialesAportadosPorCliente : null;
  const gananciaReal = tienePagoReal ? estimadoPagadoAjustado - materiales - manoDeObra : ganancia;
  // Ganancia final que de verdad se reparte entre los socios: usa el pago real si ya se confirmó,
  // y siempre resta lo que se le debe reembolsar a quien puso dinero de su bolsa en este trabajo.
  const gananciaParaReparto = tienePagoReal ? gananciaReal : ganancia;
  const restoARepartir = gananciaParaReparto - totalReembolsosTrabajo;
  const mitadResto = restoARepartir / 2;
  return {
    materiales,
    materialesAportadosPorCliente,
    estimadoAjustado,
    manoDeObra,
    desglose,
    reembolsoPorPersona,
    totalReembolsosTrabajo,
    reembolsoDeSocio,
    ganancia,
    porSocio: ganancia / 2,
    tienePagoReal,
    gananciaReal,
    estimadoPagadoAjustado,
    porSocioReal: gananciaReal / 2,
    gananciaParaReparto,
    restoARepartir,
    mitadResto,
  };
}

// Calcula cuánto se le debe a cada persona que pagó de su bolsa (socio o trabajador) — el cliente nunca se reembolsa
function calcPendientesPorPagador(data) {
  const buckets = {};
  const ensure = (key, nombre, tipo) => {
    if (!buckets[key]) buckets[key] = { key, nombre, tipo, pendiente: 0, pagado: 0, items: [] };
    return buckets[key];
  };
  const consider = (list, tipoItem, montoDe) =>
    list.forEach((item) => {
      const p = item.pagadoPor;
      if (!p || p === "empresa" || p === "cliente" || p === "sindefinir") return;
      let bucket;
      if (p.startsWith("empleado:")) {
        const empId = p.slice("empleado:".length);
        bucket = ensure(p, data.empleados.find((e) => e.id === empId)?.nombre || "Trabajador", "empleado");
      } else {
        bucket = ensure(p, data.socios.find((s) => s.id === p)?.nombre || "Socio", "socio");
      }
      const monto = montoDe(item);
      if (item.reembolsado) bucket.pagado += monto;
      else {
        bucket.pendiente += monto;
        bucket.items.push({ ...item, tipo: tipoItem, monto });
      }
    });
  consider(data.materiales, "Material", materialNeto);
  consider(data.nomina, "Nómina", (n) => Number(n.monto));
  return Object.values(buckets);
}

function calcCuentaSaldo(cuenta, data) {
  const ingresos = data.ingresos.filter((i) => i.cuentaId === cuenta.id).reduce((s, i) => s + Number(i.monto), 0);
  const gastosMat = data.materiales
    .filter((m) => m.cuentaId === cuenta.id)
    .reduce((s, m) => s + materialNeto(m), 0);
  const gastosNom = data.nomina
    .filter((n) => n.cuentaId === cuenta.id && n.estado !== "pendiente")
    .reduce((s, n) => s + Number(n.monto), 0);
  const transferIn = data.transferencias.filter((t) => t.aCuentaId === cuenta.id).reduce((s, t) => s + Number(t.monto), 0);
  const transferOut = data.transferencias.filter((t) => t.deCuentaId === cuenta.id).reduce((s, t) => s + Number(t.monto), 0);
  return Number(cuenta.saldoInicial || 0) + ingresos + transferIn - gastosMat - gastosNom - transferOut;
}

// Nombre legible de quién pagó: empresa, cliente, un socio, o un trabajador (formato "empleado:<id>")
function pagadorNombre(data, pagadoPor) {
  if (!pagadoPor || pagadoPor === "empresa") return data.empresaNombre || "Empresa";
  if (pagadoPor === "cliente") return "Cliente";
  if (pagadoPor === "sindefinir") return "Aún no se sabe";
  if (pagadoPor.startsWith("empleado:")) {
    const id = pagadoPor.slice("empleado:".length);
    return data.empleados.find((e) => e.id === id)?.nombre || "Trabajador";
  }
  return data.socios.find((s) => s.id === pagadoPor)?.nombre || "—";
}

// Calcula a quién le toca pagar la mano de obra ese mes, según la rotación configurada
function socioEnTurno(data, fechaISO = todayISO()) {
  const r = data.rotacionNomina;
  if (!r || !r.activa || data.socios.length < 2) return null;
  const [y1, m1] = r.mesInicio.split("-").map(Number);
  const [y2, m2] = fechaISO.slice(0, 7).split("-").map(Number);
  const diff = (y2 - y1) * 12 + (m2 - m1);
  const inicioIdx = data.socios.findIndex((s) => s.id === r.socioInicioId);
  const idx = inicioIdx === -1 ? 0 : inicioIdx;
  const otroIdx = idx === 0 ? 1 : 0;
  const turnoIdx = ((diff % 2) + 2) % 2 === 0 ? idx : otroIdx;
  return data.socios[turnoIdx]?.id || null;
}

// A quién le toca pagar la SIGUIENTE factura de materiales de un trabajo en específico —
// se alterna: si la última factura de ese trabajo la pagó Boris, la siguiente le toca a David, y así.
function socioTurnoMaterial(data, trabajoId) {
  if (!trabajoId || data.socios.length < 2) return null;
  const pagosSocios = data.materiales
    .filter((m) => m.trabajoId === trabajoId && data.socios.some((s) => s.id === m.pagadoPor))
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  if (pagosSocios.length === 0) return data.socios[0].id;
  const ultimoPagador = pagosSocios[pagosSocios.length - 1].pagadoPor;
  const otro = data.socios.find((s) => s.id !== ultimoPagador);
  return otro ? otro.id : data.socios[0].id;
}

// Igual que arriba pero para pagos de nómina de un trabajo en específico —
// si Boris pagó el último pago de nómina de ese trabajo, el siguiente le toca a David.
function socioTurnoNominaTrabajo(data, trabajoId) {
  if (!trabajoId || data.socios.length < 2) return null;
  const pagosSocios = data.nomina
    .filter((n) => n.trabajoId === trabajoId && data.socios.some((s) => s.id === n.pagadoPor))
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  if (pagosSocios.length === 0) return data.socios[0].id;
  const ultimoPagador = pagosSocios[pagosSocios.length - 1].pagadoPor;
  const otro = data.socios.find((s) => s.id !== ultimoPagador);
  return otro ? otro.id : data.socios[0].id;
}

/* ---------------- Dashboard ---------------- */
function Dashboard({ data }) {
  const trabajosActivos = data.trabajos.filter((t) => t.estado !== "cerrado");
  const totales = data.trabajos
    .filter((t) => !t.pagoPersonal)
    .reduce(
    (acc, t) => {
      const c = calcTrabajo(t, data);
      acc.estimado += Number(t.estimado || 0);
      acc.materiales += c.materiales;
      acc.manoDeObra += c.manoDeObra;
      acc.ganancia += c.ganancia;
      return acc;
    },
    { estimado: 0, materiales: 0, manoDeObra: 0, ganancia: 0 }
  );
  const pendientes = calcPendientesPorPagador(data);
  const totalReembolsoPendiente = pendientes.reduce((s, b) => s + b.pendiente, 0);
  const saldoTotalCuentas = data.cuentas.reduce((s, c) => s + calcCuentaSaldo(c, data), 0);

  return (
    <div>
      <SectionTitle sub="Vista general de la compañía, actualizada en automático">Resumen general</SectionTitle>

      {data.rotacionNomina?.activa && (
        <div className="card p-3 mb-4 flex items-center justify-between" style={{ borderLeft: `4px solid ${AMBER}` }}>
          <span className="text-sm">Este mes le toca pagar la nómina a</span>
          <span className="stamp text-[13px]">{pagadorNombre(data, socioEnTurno(data))}</span>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Stat label="Trabajos activos" value={trabajosActivos.length} />
        <Stat label="Saldo en cuentas" value={money(saldoTotalCuentas)} accent={saldoTotalCuentas >= 0 ? GREEN : RED} />
        <Stat label="Ganancia acumulada" value={money(totales.ganancia)} accent={totales.ganancia >= 0 ? GREEN : RED} />
        <Stat label="Reembolsos pendientes" value={money(totalReembolsoPendiente)} accent={totalReembolsoPendiente > 0 ? RED : GREEN} />
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="card p-4">
          <div className="stamp text-[13px] text-[#7A7263] mb-3">GANANCIA POR SOCIO</div>
          {data.socios.map((s) => (
            <div key={s.id} className="flex justify-between items-center py-2 border-b last:border-0" style={{ borderColor: LINE }}>
              <span className="text-sm">{s.nombre}</span>
              <span className="mono text-sm font-semibold" style={{ color: totales.ganancia / 2 >= 0 ? GREEN : RED }}>
                {money(totales.ganancia / 2)}
              </span>
            </div>
          ))}
        </div>

        <div className="card p-4">
          <div className="stamp text-[13px] text-[#7A7263] mb-3">GASTOS ACUMULADOS</div>
          <Row label="Materiales" value={money(totales.materiales)} />
          <Row label="Mano de obra / nómina" value={money(totales.manoDeObra)} />
          <Row label="Estimado total contratado" value={money(totales.estimado)} bold />
        </div>
      </div>

      <div className="card p-4 mt-4">
        <div className="stamp text-[13px] text-[#7A7263] mb-3">REEMBOLSOS PENDIENTES</div>
        {pendientes.filter((b) => b.pendiente > 0).map((b) => (
          <Row key={b.key} label={`${b.nombre} ${b.tipo === "empleado" ? "(trabajador)" : ""}`} value={money(b.pendiente)} accent={RED} />
        ))}
        {totalReembolsoPendiente === 0 && <p className="text-[13px] text-[#7A7263] mt-1">No hay reembolsos pendientes.</p>}
      </div>

      <div className="card p-4 mt-4" style={{ borderLeft: `4px solid ${RED}` }}>
        <div className="flex items-start gap-3">
          <ShieldAlert size={20} className="text-[#A13D2E] shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="stamp text-[13px] mb-1">RESPALDO DE SEGURIDAD</div>
            <p className="text-[13px] text-[#4A4238] mb-3">Descarga tus datos de vez en cuando. Es tu copia independiente, por si algún día no puedes entrar aquí.</p>
            <button className="btn-primary" onClick={() => descargarRespaldo(data)}>
              <Download size={14} /> Descargar respaldo (JSON)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div className="card p-3">
      <div className="text-[10px] uppercase tracking-widest text-[#7A7263] mb-1">{label}</div>
      <div className="mono text-lg sm:text-xl font-semibold" style={{ color: accent || INK }}>
        {value}
      </div>
    </div>
  );
}

function Row({ label, value, bold, accent }) {
  return (
    <div className="flex justify-between items-center py-1.5 text-sm">
      <span className={bold ? "font-medium" : "text-[#4A4238]"}>{label}</span>
      <span className={`mono ${bold ? "font-semibold" : ""}`} style={{ color: accent }}>{value}</span>
    </div>
  );
}

/* ---------------- Trabajos ---------------- */
// Mini componente para subir/mostrar fotos de "antes" y "después" en un trabajo.
// Comprime la foto, la sube a Storage (igual que las demás fotos de la app) y guarda solo el link.
function FotosAntesDespues({ titulo, fotos, onAdd, onRemove, onViewPhoto }) {
  const [subiendo, setSubiendo] = useState(false);
  const inputId = "fotos-" + titulo;

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setSubiendo(true);
    try {
      for (const file of files) {
        const dataUrl = await compressImage(file, 1000, 0.55);
        const url = await subirFoto(dataUrl);
        onAdd(url);
      }
    } finally {
      setSubiendo(false);
      e.target.value = "";
    }
  };

  return (
    <div className="border p-2" style={{ borderColor: LINE }}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] uppercase text-[#7A7263]">{titulo}</span>
        <label htmlFor={inputId} className="text-[11px] px-2 py-1 border cursor-pointer flex items-center gap-1" style={{ borderColor: AMBER, color: AMBER }}>
          <Camera size={12} /> {subiendo ? "Subiendo..." : "Agregar"}
        </label>
        <input id={inputId} type="file" accept="image/*" multiple className="hidden" onChange={handleFiles} disabled={subiendo} />
      </div>
      {fotos.length === 0 ? (
        <p className="text-[11px] text-[#C9C1B0]">Sin fotos todavía.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {fotos.map((f, idx) => (
            <div key={idx} className="relative">
              <img
                src={f}
                alt={`${titulo} ${idx + 1}`}
                className="w-14 h-14 object-cover border cursor-pointer"
                style={{ borderColor: LINE }}
                onClick={() => onViewPhoto?.(f)}
              />
              <button
                type="button"
                onClick={() => onRemove(idx)}
                className="absolute -top-1.5 -right-1.5 bg-white border rounded-full w-4 h-4 flex items-center justify-center"
                style={{ borderColor: LINE }}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Trabajos({ data, update, onViewPhoto }) {
  const [form, setForm] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [orden, setOrden] = useState("numero"); // "numero" = orden en que se agregaron, "abecedario" = A-Z
  const [materialesTrabajo, setMaterialesTrabajo] = useState(null);
  const [bitacoraTrabajo, setBitacoraTrabajo] = useState(null);
  const [pagosTrabajo, setPagosTrabajo] = useState(null);
  const [mostrarPagosPersonales, setMostrarPagosPersonales] = useState(false);
  const [mostrarMapa, setMostrarMapa] = useState(false);
  const [filtroEstado, setFiltroEstado] = useState("todos");
  const [busqueda, setBusqueda] = useState("");

  const addTrabajo = () => {
    if (!form?.nombre) return;
    update((d) => {
      d.trabajos.push({
        id: uid(),
        nombre: form.nombre,
        apodo: form.apodo || "",
        numeroTrabajo: form.numeroTrabajo || "",
        cliente: form.cliente || "",
        managerCliente: form.managerCliente || "",
        direccion: form.direccion || "",
        descripcionTrabajo: form.descripcionTrabajo || "",
        empleadoIds: [],
        estimado: Number(form.estimado || 0),
        estimadoPagado: "",
        fecha: form.fecha || todayISO(),
        diasEstimados: Number(form.diasEstimados || 0),
        fechaTerminado: "",
        fechaFacturaEnviada: "",
        estado: "activo",
        pagoPersonal: !!form.pagoPersonal,
        formaPagoPersonal: form.pagoPersonal ? (form.formaPagoPersonal || "efectivo") : "",
        numeroChequePersonal: form.pagoPersonal && form.formaPagoPersonal === "cheque" ? (form.numeroChequePersonal || "") : "",
        montoRecibidoPersonal: form.pagoPersonal ? Number(form.montoRecibidoPersonal || 0) : 0,
      });
    });
    setForm(null);
  };

  return (
    <div>
      <SectionTitle sub="Estimado menos materiales y mano de obra = ganancia, dividida 50/50">Trabajos</SectionTitle>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {!form && (
          <button className="btn-primary" onClick={() => setForm({ fecha: todayISO() })}>
            <Plus size={15} /> Nuevo trabajo
          </button>
        )}
        <button
          className="text-[12px] px-2.5 py-1.5 border flex items-center gap-1"
          style={{ borderColor: GREEN, color: GREEN }}
          onClick={() => setMostrarMapa(true)}
        >
          <MapPin size={13} /> Ver mapa de trabajos
        </button>
        <button
          className="text-[12px] px-2.5 py-1.5 border flex items-center gap-1"
          style={{ borderColor: AMBER, color: AMBER }}
          onClick={() => setMostrarPagosPersonales(true)}
        >
          <Printer size={13} /> Reporte de trabajos por fuera
        </button>
      </div>
      {form && (
        <div className="card p-4 mb-4 space-y-2">
          <div className="flex items-center gap-2 border" style={{ borderColor: LINE }}>
            <Briefcase size={16} className="text-[#7A7263] ml-2.5 shrink-0" />
            <input
              className="flex-1 py-2 pr-2 text-sm outline-none"
              placeholder="Nombre del trabajo"
              value={form.nombre || ""}
              onChange={(e) => setForm({ ...form, nombre: e.target.value })}
            />
          </div>
          <div className="flex items-center gap-2 border" style={{ borderColor: LINE }}>
            <Tag size={16} className="text-[#7A7263] ml-2.5 shrink-0" />
            <input
              className="flex-1 py-2 pr-2 text-sm outline-none"
              placeholder='Apodo (ej. "Trabajo 1", "el del letrero roto")'
              value={form.apodo || ""}
              onChange={(e) => setForm({ ...form, apodo: e.target.value })}
            />
          </div>
          <div className="flex items-center gap-2 border" style={{ borderColor: LINE }}>
            <Hash size={16} className="text-[#7A7263] ml-2.5 shrink-0" />
            <input
              className="flex-1 py-2 pr-2 text-sm outline-none"
              placeholder="Número de trabajo (ej. 1, 2, 3...)"
              value={form.numeroTrabajo || ""}
              onChange={(e) => setForm({ ...form, numeroTrabajo: e.target.value })}
            />
          </div>
          <input className="ledger-input" placeholder="Cliente / empresa" value={form.cliente || ""} onChange={(e) => setForm({ ...form, cliente: e.target.value })} />
          <input className="ledger-input" placeholder="Manager / contacto del cliente" value={form.managerCliente || ""} onChange={(e) => setForm({ ...form, managerCliente: e.target.value })} />
          <input className="ledger-input" placeholder="Dirección" value={form.direccion || ""} onChange={(e) => setForm({ ...form, direccion: e.target.value })} />
          <label className="text-[11px] text-[#7A7263] block mb-0.5">Trabajo a realizar en ese lugar</label>
          <NumberedListEditor
            value={form.descripcionTrabajo || ""}
            onChange={(val) => setForm({ ...form, descripcionTrabajo: val })}
          />
          <input className="ledger-input" type="number" placeholder="Estimado ($)" value={form.estimado || ""} onChange={(e) => setForm({ ...form, estimado: e.target.value })} />
          <label className="text-[11px] text-[#7A7263] block">Fecha de inicio</label>
          <input className="ledger-input" type="date" value={form.fecha} onChange={(e) => setForm({ ...form, fecha: e.target.value })} />
          <input className="ledger-input" type="number" placeholder="Tiempo estimado para terminar (días)" value={form.diasEstimados || ""} onChange={(e) => setForm({ ...form, diasEstimados: e.target.value })} />
          <label className="flex items-center gap-1.5 text-[12px] text-[#7A7263] cursor-pointer">
            <input type="checkbox" checked={!!form.pagoPersonal} onChange={(e) => setForm({ ...form, pagoPersonal: e.target.checked })} />
            Se paga a cuenta personal (no es dinero de la empresa — se excluye del reparto de ganancia)
          </label>
          {form.pagoPersonal && (
            <div className="border p-2 space-y-2" style={{ borderColor: AMBER }}>
              <label className="text-[11px] text-[#7A7263] block">¿Cómo se cobró este trabajo?</label>
              <select className="ledger-input" value={form.formaPagoPersonal || "efectivo"} onChange={(e) => setForm({ ...form, formaPagoPersonal: e.target.value })}>
                <option value="efectivo">Efectivo</option>
                <option value="cheque">Cheque</option>
                <option value="zelle">Zelle</option>
              </select>
              {form.formaPagoPersonal === "cheque" && (
                <input className="ledger-input" placeholder="Número de cheque" value={form.numeroChequePersonal || ""} onChange={(e) => setForm({ ...form, numeroChequePersonal: e.target.value })} />
              )}
              <input className="ledger-input" type="number" placeholder="Monto recibido" value={form.montoRecibidoPersonal || ""} onChange={(e) => setForm({ ...form, montoRecibidoPersonal: e.target.value })} />
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button className="btn-primary" onClick={addTrabajo}><Check size={14} /> Guardar</button>
            <button className="text-sm text-[#7A7263] px-3" onClick={() => setForm(null)}>Cancelar</button>
          </div>
        </div>
      )}

      <div className="card p-3 mb-4">
        <label className="text-[11px] text-[#7A7263] uppercase tracking-wide block mb-1">Buscar por nombre o cliente:</label>
        <input
          className="ledger-input mb-2"
          placeholder="Escribe para buscar…"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
        />
        <label className="text-[11px] text-[#7A7263] uppercase tracking-wide block mb-1">Ver trabajos:</label>
        <select className="ledger-input" value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value)}>
          <option value="todos">Todos</option>
          <option value="activo">Solo activos</option>
          <option value="cerrado">Solo concluidos</option>
          <option value="personal">Solo pago personal</option>
        </select>
      </div>

      <div className="flex items-center gap-2 mb-3">
        <span className="text-[11px] text-[#7A7263] uppercase tracking-wide">Ordenar:</span>
        <button
          className="text-xs px-2.5 py-1 border"
          style={{
            borderColor: orden === "numero" ? AMBER : LINE,
            background: orden === "numero" ? "#F3EEE4" : "#fff",
            color: orden === "numero" ? "#1E2A38" : "#7A7263",
          }}
          onClick={() => setOrden("numero")}
        >
          Por número
        </button>
        <button
          className="text-xs px-2.5 py-1 border"
          style={{
            borderColor: orden === "abecedario" ? AMBER : LINE,
            background: orden === "abecedario" ? "#F3EEE4" : "#fff",
            color: orden === "abecedario" ? "#1E2A38" : "#7A7263",
          }}
          onClick={() => setOrden("abecedario")}
        >
          A-Z
        </button>
      </div>

      <div className="space-y-2">
        {data.trabajos.length === 0 && <Empty text="Aún no hay trabajos registrados." />}
        {(() => {
          const q = busqueda.trim().toLowerCase();
          const pasaFiltro = (t) => {
            if (filtroEstado === "activo" && t.estado === "cerrado") return false;
            if (filtroEstado === "cerrado" && t.estado !== "cerrado") return false;
            if (filtroEstado === "personal" && !t.pagoPersonal) return false;
            if (q && !((t.apodo || "").toLowerCase().includes(q) || (t.nombre || "").toLowerCase().includes(q) || (t.cliente || "").toLowerCase().includes(q))) return false;
            return true;
          };
          const trabajosFiltrados = data.trabajos.filter(pasaFiltro);
          if (data.trabajos.length > 0 && trabajosFiltrados.length === 0) {
            return <Empty text="Ningún trabajo coincide con esta búsqueda o filtro." />;
          }
          return [...trabajosFiltrados]
            .sort((a, b) => {
              if (orden === "abecedario") {
                return (a.apodo || a.nombre || "").localeCompare(b.apodo || b.nombre || "", "es", { sensitivity: "base" });
              }
              // Orden por número: compara como números si ambos tienen número de trabajo (así 2 va antes que 10).
              // Los que no tienen número asignado se quedan al final, en el orden en que se agregaron.
              const na = a.numeroTrabajo?.trim();
              const nb = b.numeroTrabajo?.trim();
              if (na && nb) {
                const numA = parseFloat(na.replace(/[^\d.]/g, ""));
                const numB = parseFloat(nb.replace(/[^\d.]/g, ""));
                if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
                return na.localeCompare(nb, "es", { numeric: true, sensitivity: "base" });
              }
              if (na && !nb) return -1;
              if (!na && nb) return 1;
              return 0;
            })
            .map((t, idx) => {
          const c = calcTrabajo(t, data);
          const open = openId === t.id;
          return (
            <div key={t.id} className="card">
              <div className="w-full text-left p-4 flex justify-between items-center cursor-pointer" onClick={() => setOpenId(open ? null : t.id)}>
                <div>
                  <div className="font-medium text-sm">
                    <span className="mono text-[#7A7263] mr-1.5">{t.numeroTrabajo ? `#${t.numeroTrabajo}` : `${idx + 1}.`}</span>
                    {t.apodo || t.nombre}
                    {t.pagoPersonal && (
                      <span className="ml-1.5 text-[9px] uppercase px-1.5 py-0.5" style={{ background: "#FBE9D9", color: AMBER }}>Pago personal</span>
                    )}
                  </div>
                  <div className="text-[12px] text-[#7A7263]">
                    {t.apodo ? `${t.nombre} · ` : ""}{t.cliente}{t.managerCliente ? ` (${t.managerCliente})` : ""}
                    {t.direccion && (
                      <>
                        {" · "}
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t.direccion)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                          style={{ color: GREEN }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {t.direccion}
                        </a>
                      </>
                    )}
                    {" · "}{fmtDate(t.fecha)}{t.diasEstimados ? ` · ${t.diasEstimados} días est.` : ""}
                  </div>
                  {(t.empleadoIds || []).length > 0 && (
                    <div className="text-[11px] text-[#7A7263] mt-0.5">
                      Realizado por: {(t.empleadoIds || []).map((id) => data.empleados.find((e) => e.id === id)?.nombre).filter(Boolean).join(", ")}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="mono text-sm font-semibold" style={{ color: (c.tienePagoReal ? c.gananciaReal : c.ganancia) >= 0 ? GREEN : RED }}>
                    {money(c.tienePagoReal ? c.gananciaReal : c.ganancia)}
                  </div>
                  <div className="text-[10px] text-[#7A7263] uppercase">{c.tienePagoReal ? "ganancia real" : "ganancia"}</div>
                </div>
              </div>
              {open && (
                <div style={{ borderTop: `1px dashed ${LINE}` }} className="p-4 pt-3 space-y-1">
                  <label className="text-[11px] text-[#7A7263] block mb-0.5">Nombre del trabajo</label>
                  <div className="flex items-center gap-2 border mb-3" style={{ borderColor: LINE }}>
                    <Briefcase size={14} className="text-[#7A7263] ml-2 shrink-0" />
                    <input
                      className="flex-1 py-1.5 pr-2 text-xs outline-none"
                      value={t.nombre || ""}
                      onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).nombre = e.target.value; })}
                    />
                  </div>
                  <div className="mb-1">
                    <label className="text-[11px] text-[#7A7263] block mb-0.5">Estimado ($)</label>
                    <input
                      className="ledger-input text-xs"
                      type="number"
                      value={t.estimado ?? ""}
                      onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).estimado = e.target.value; })}
                    />
                  </div>
                  <Row label="Materiales gastados" value={money(c.materiales)} accent={RED} />
                  {c.desglose.length > 0 && (
                    <div className="pl-3 mb-1 space-y-0.5">
                      {c.desglose.map((d, i) => (
                        <div key={i} className="flex justify-between text-[11px] text-[#7A7263]">
                          <span>{d.nombre} · {d.tipoLabel}</span>
                          <span className="mono">{money(d.monto)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <Row label="Mano de obra / nómina" value={money(c.manoDeObra)} accent={RED} />
                  {c.materialesAportadosPorCliente > 0 && (
                    <>
                      <Row label="Materiales que compró el cliente directo" value={money(c.materialesAportadosPorCliente)} />
                      <Row label="Estimado ajustado (estimado − esos materiales)" value={money(c.estimadoAjustado)} />
                    </>
                  )}
                  {c.reembolsoPorPersona.length > 0 && (
                    <div className="pl-3 mb-1 space-y-0.5">
                      {c.reembolsoPorPersona.map((r, i) => (
                        <div key={i} className="flex justify-between text-[11px]" style={{ color: AMBER }}>
                          <span>Reembolsar a {r.nombre} por {r.tipoLabel}</span>
                          <span className="mono">{money(r.monto)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <Row label="Ganancia según estimado" value={money(c.ganancia)} bold={!c.tienePagoReal} accent={c.ganancia >= 0 ? GREEN : RED} />

                  <div className="mt-2 mb-1">
                    <label className="text-[11px] text-[#7A7263] block mb-0.5">Total final que pagó el cliente (el número completo, sin restar nada — la app resta sola los materiales que compró el cliente)</label>
                    <input
                      className="ledger-input text-xs"
                      type="number"
                      placeholder="Déjalo vacío si pagaron el estimado completo"
                      value={t.estimadoPagado ?? ""}
                      onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).estimadoPagado = e.target.value; })}
                    />
                  </div>
                  {c.tienePagoReal && c.materialesAportadosPorCliente > 0 && (
                    <Row label="Total final ajustado (menos esos materiales)" value={money(c.estimadoPagadoAjustado)} />
                  )}
                  {c.tienePagoReal && (
                    <Row label="Ganancia real (según lo pagado)" value={money(c.gananciaReal)} bold accent={c.gananciaReal >= 0 ? GREEN : RED} />
                  )}

                  <div className="grid grid-cols-2 gap-2 pt-2">
                    {data.socios.map((s) => (
                      <div key={s.id} className="bg-[#F3EEE4] p-2 text-center">
                        <div className="text-[10px] text-[#7A7263] uppercase">{s.nombre}</div>
                        <div className="mono text-sm font-semibold">{money(c.mitadResto)}</div>
                        <div className="text-[9px] text-[#7A7263]">ganancia (ya restado reembolso)</div>
                      </div>
                    ))}
                  </div>
                  {c.totalReembolsosTrabajo > 0 && (
                    <div className="grid grid-cols-2 gap-2 pt-1.5">
                      {data.socios.map((s) => {
                        const reemb = c.reembolsoDeSocio(s.id);
                        if (reemb <= 0) return <div key={s.id} />;
                        return (
                          <div key={s.id} className="p-2 text-center" style={{ background: "#FBF3E3", border: "1px solid #E8D9A8" }}>
                            <div className="text-[10px] uppercase" style={{ color: "#8A6416" }}>+ reembolso a {s.nombre}</div>
                            <div className="mono text-sm font-semibold" style={{ color: "#8A6416" }}>{money(reemb)}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <label className="text-[11px] text-[#7A7263] block mb-0.5 mt-3">Trabajo a realizar en ese lugar</label>
                  <div className="mb-3">
                    <NumberedListEditor
                      value={t.descripcionTrabajo || ""}
                      onChange={(val) => update((d) => { d.trabajos.find((x) => x.id === t.id).descripcionTrabajo = val; })}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <FotosAntesDespues
                      titulo="Antes"
                      fotos={t.fotosAntes || []}
                      onViewPhoto={onViewPhoto}
                      onAdd={(url) => update((d) => {
                        const trabajo = d.trabajos.find((x) => x.id === t.id);
                        trabajo.fotosAntes = [...(trabajo.fotosAntes || []), url];
                      })}
                      onRemove={(idx) => update((d) => {
                        const trabajo = d.trabajos.find((x) => x.id === t.id);
                        trabajo.fotosAntes = (trabajo.fotosAntes || []).filter((_, i) => i !== idx);
                      })}
                    />
                    <FotosAntesDespues
                      titulo="Después"
                      fotos={t.fotosDespues || []}
                      onViewPhoto={onViewPhoto}
                      onAdd={(url) => update((d) => {
                        const trabajo = d.trabajos.find((x) => x.id === t.id);
                        trabajo.fotosDespues = [...(trabajo.fotosDespues || []), url];
                      })}
                      onRemove={(idx) => update((d) => {
                        const trabajo = d.trabajos.find((x) => x.id === t.id);
                        trabajo.fotosDespues = (trabajo.fotosDespues || []).filter((_, i) => i !== idx);
                      })}
                    />
                  </div>

                  <label className="text-[11px] text-[#7A7263] block mb-1">¿Quién realizó este trabajo?</label>
                  {data.empleados.length === 0 && <p className="text-[13px] text-[#7A7263] mb-3">No hay empleados dados de alta todavía (pestaña Nómina).</p>}
                  <div className="flex flex-wrap gap-2 mb-3">
                    {data.empleados.map((emp) => {
                      const selected = (t.empleadoIds || []).includes(emp.id);
                      return (
                        <button
                          key={emp.id}
                          type="button"
                          onClick={() =>
                            update((d) => {
                              const trabajo = d.trabajos.find((x) => x.id === t.id);
                              const set = new Set(trabajo.empleadoIds || []);
                              set.has(emp.id) ? set.delete(emp.id) : set.add(emp.id);
                              trabajo.empleadoIds = Array.from(set);
                            })
                          }
                          className="text-xs px-2.5 py-1.5 border"
                          style={{
                            borderColor: selected ? AMBER : LINE,
                            background: selected ? "#F3EEE4" : "#fff",
                            color: selected ? "#1E2A38" : "#7A7263",
                          }}
                        >
                          {selected ? "✓ " : ""}{emp.nombre}
                        </button>
                      );
                    })}
                  </div>

                  <label className="text-[11px] text-[#7A7263] block mb-0.5">Apodo (la palabra que usan para nombrarlo)</label>
                  <div className="flex items-center gap-2 border mb-3" style={{ borderColor: LINE }}>
                    <Tag size={14} className="text-[#7A7263] ml-2 shrink-0" />
                    <input
                      className="flex-1 py-1.5 pr-2 text-xs outline-none"
                      value={t.apodo || ""}
                      onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).apodo = e.target.value; })}
                    />
                  </div>

                  <label className="text-[11px] text-[#7A7263] block mb-0.5">Número de trabajo</label>
                  <div className="flex items-center gap-2 border mb-3" style={{ borderColor: LINE }}>
                    <Hash size={14} className="text-[#7A7263] ml-2 shrink-0" />
                    <input
                      className="flex-1 py-1.5 pr-2 text-xs outline-none"
                      value={t.numeroTrabajo || ""}
                      onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).numeroTrabajo = e.target.value; })}
                    />
                  </div>

                  <div className="stamp text-[12px] text-[#7A7263] mt-4 mb-2">CLIENTE</div>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <div>
                      <label className="text-[11px] text-[#7A7263] block mb-0.5">Cliente / empresa</label>
                      <input
                        className="ledger-input text-xs"
                        value={t.cliente || ""}
                        onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).cliente = e.target.value; })}
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-[#7A7263] block mb-0.5">Manager / contacto</label>
                      <input
                        className="ledger-input text-xs"
                        value={t.managerCliente || ""}
                        onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).managerCliente = e.target.value; })}
                      />
                    </div>
                  </div>
                  <label className="text-[11px] text-[#7A7263] block mb-0.5">Dirección</label>
                  <input
                    className="ledger-input text-xs mb-1"
                    value={t.direccion || ""}
                    onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).direccion = e.target.value; })}
                  />
                  {t.direccion && (
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t.direccion)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] underline flex items-center gap-1 mb-2"
                      style={{ color: GREEN }}
                    >
                      <MapPin size={11} /> Abrir en Google Maps
                    </a>
                  )}

                  <div className="stamp text-[12px] text-[#7A7263] mt-4 mb-2">FECHAS Y TIEMPOS</div>
                  <div className="grid grid-cols-2 gap-2 mb-1">
                    <div>
                      <label className="text-[11px] text-[#7A7263] block mb-0.5">Fecha de inicio</label>
                      <input
                        className="ledger-input text-xs"
                        type="date"
                        value={t.fecha || ""}
                        onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).fecha = e.target.value; })}
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-[#7A7263] block mb-0.5">Tiempo estimado (días)</label>
                      <input
                        className="ledger-input text-xs"
                        type="number"
                        value={t.diasEstimados || ""}
                        onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).diasEstimados = Number(e.target.value); })}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <div>
                      <label className="text-[11px] text-[#7A7263] block mb-0.5">Fecha de conclusión</label>
                      <input
                        className="ledger-input text-xs"
                        type="date"
                        value={t.fechaTerminado || ""}
                        onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).fechaTerminado = e.target.value; })}
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-[#7A7263] block mb-0.5">Factura enviada</label>
                      <input
                        className="ledger-input text-xs"
                        type="date"
                        value={t.fechaFacturaEnviada || ""}
                        onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).fechaFacturaEnviada = e.target.value; })}
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-1.5 text-[12px] text-[#7A7263] cursor-pointer mb-2">
                    <input
                      type="checkbox"
                      checked={!!t.pagoPersonal}
                      onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).pagoPersonal = e.target.checked; })}
                    />
                    Se paga a cuenta personal (no es dinero de la empresa — se excluye del reparto de ganancia)
                  </label>
                  {t.pagoPersonal && (
                    <div className="border p-2 space-y-2 mb-2" style={{ borderColor: AMBER }}>
                      <label className="text-[11px] text-[#7A7263] block">¿Cómo se cobró este trabajo?</label>
                      <select
                        className="ledger-input text-xs"
                        value={t.formaPagoPersonal || "efectivo"}
                        onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).formaPagoPersonal = e.target.value; })}
                      >
                        <option value="efectivo">Efectivo</option>
                        <option value="cheque">Cheque</option>
                        <option value="zelle">Zelle</option>
                      </select>
                      {t.formaPagoPersonal === "cheque" && (
                        <input
                          className="ledger-input text-xs"
                          placeholder="Número de cheque"
                          value={t.numeroChequePersonal || ""}
                          onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).numeroChequePersonal = e.target.value; })}
                        />
                      )}
                      <input
                        className="ledger-input text-xs"
                        type="number"
                        placeholder="Monto recibido"
                        value={t.montoRecibidoPersonal ?? ""}
                        onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).montoRecibidoPersonal = Number(e.target.value); })}
                      />
                    </div>
                  )}
                  <div className="flex justify-between items-center pt-3">
                    <select
                      className="ledger-input w-auto text-xs"
                      value={t.estado}
                      onChange={(e) =>
                        update((d) => {
                          d.trabajos.find((x) => x.id === t.id).estado = e.target.value;
                          if (e.target.value === "cerrado") {
                            const existing = d.reportes.find((r) => r.trabajoId === t.id);
                            if (!existing) d.reportes.push({ id: uid(), trabajoId: t.id, fechaCierre: todayISO(), notas: "" });
                            else if (!existing.fechaCierre) existing.fechaCierre = todayISO();
                          }
                        })
                      }
                    >
                      <option value="activo">Activo</option>
                      <option value="cerrado">Cerrado</option>
                    </select>
                    <button
                      className="text-[#A13D2E] text-xs flex items-center gap-1"
                      onClick={() => update((d) => { d.trabajos = d.trabajos.filter((x) => x.id !== t.id); })}
                    >
                      <Trash2 size={13} /> Eliminar
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-3 pt-2">
                    <button className="text-[11px] text-[#7A7263] underline flex items-center gap-1" onClick={() => setMaterialesTrabajo(t)}>
                      <Printer size={12} /> Imprimir/descargar materiales
                    </button>
                    <button className="text-[11px] text-[#7A7263] underline flex items-center gap-1" onClick={() => setBitacoraTrabajo(t)}>
                      <Printer size={12} /> Imprimir/descargar bitácora
                    </button>
                    <button className="text-[11px] text-[#7A7263] underline flex items-center gap-1" onClick={() => setPagosTrabajo({ trabajo: t, tipo: "empresa" })}>
                      <Printer size={12} /> Imprimir/descargar pagos — cuenta empresa
                    </button>
                    <button className="text-[11px] text-[#7A7263] underline flex items-center gap-1" onClick={() => setPagosTrabajo({ trabajo: t, tipo: "personal" })}>
                      <Printer size={12} /> Imprimir/descargar pagos — cuenta personal/CashApp
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        });
        })()}
      </div>
      {materialesTrabajo && <MaterialesTrabajoModal trabajo={materialesTrabajo} data={data} onClose={() => setMaterialesTrabajo(null)} />}
      {bitacoraTrabajo && <BitacoraTrabajoModal trabajo={bitacoraTrabajo} data={data} onClose={() => setBitacoraTrabajo(null)} />}
      {pagosTrabajo && (
        <PagosTrabajoModal
          trabajo={data.trabajos.find((x) => x.id === pagosTrabajo.trabajo.id) || pagosTrabajo.trabajo}
          tipo={pagosTrabajo.tipo}
          data={data}
          update={update}
          onClose={() => setPagosTrabajo(null)}
        />
      )}
      {mostrarPagosPersonales && <PagosPersonalesModal data={data} onClose={() => setMostrarPagosPersonales(false)} />}
      {mostrarMapa && <MapaTrabajosModal data={data} update={update} onClose={() => setMostrarMapa(false)} />}
    </div>
  );
}

/* ---------------- Nomina ---------------- */
/* ---------------- Bitácora de actividad diaria ---------------- */
/* ---------------- Clientes ---------------- */
function Clientes({ data, update }) {
  const [form, setForm] = useState(null);
  const [openId, setOpenId] = useState(null);

  const addCliente = () => {
    if (!form?.nombre) return;
    update((d) =>
      d.clientes.push({
        id: uid(),
        nombre: form.nombre,
        contacto: form.contacto || "",
        telefono: form.telefono || "",
        correo: form.correo || "",
        direccion: form.direccion || "",
        notas: form.notas || "",
      })
    );
    setForm(null);
  };

  const trabajosDeCliente = (nombreCliente) => data.trabajos.filter((t) => t.cliente === nombreCliente);

  return (
    <div>
      <SectionTitle sub="Toda la información de cada cliente en un solo lugar">Clientes</SectionTitle>

      {!form ? (
        <button className="btn-primary mb-4" onClick={() => setForm({})}><Plus size={15} /> Nuevo cliente</button>
      ) : (
        <div className="card p-4 mb-4 space-y-2">
          <input className="ledger-input" placeholder="Nombre del cliente / empresa" value={form.nombre || ""} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
          <input className="ledger-input" placeholder="Contacto principal / manager" value={form.contacto || ""} onChange={(e) => setForm({ ...form, contacto: e.target.value })} />
          <div className="flex items-center gap-2 border" style={{ borderColor: LINE }}>
            <Phone size={16} className="text-[#7A7263] ml-2.5 shrink-0" />
            <input className="flex-1 py-2 pr-2 text-sm outline-none" placeholder="Teléfono" value={form.telefono || ""} onChange={(e) => setForm({ ...form, telefono: e.target.value })} />
          </div>
          <div className="flex items-center gap-2 border" style={{ borderColor: LINE }}>
            <Mail size={16} className="text-[#7A7263] ml-2.5 shrink-0" />
            <input className="flex-1 py-2 pr-2 text-sm outline-none" placeholder="Correo" value={form.correo || ""} onChange={(e) => setForm({ ...form, correo: e.target.value })} />
          </div>
          <input className="ledger-input" placeholder="Dirección" value={form.direccion || ""} onChange={(e) => setForm({ ...form, direccion: e.target.value })} />
          <textarea className="ledger-input" rows={3} placeholder="Notas (preferencias, forma de pago, lo que sea útil recordar)" value={form.notas || ""} onChange={(e) => setForm({ ...form, notas: e.target.value })} />
          <div className="flex gap-2 pt-1">
            <button className="btn-primary" onClick={addCliente}><Check size={14} /> Guardar</button>
            <button className="text-sm text-[#7A7263] px-3" onClick={() => setForm(null)}>Cancelar</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {data.clientes.length === 0 && <Empty text="Aún no hay clientes registrados." />}
        {data.clientes.map((c) => {
          const open = openId === c.id;
          const trabajosRelacionados = trabajosDeCliente(c.nombre);
          return (
            <div key={c.id} className="card">
              <button className="w-full text-left p-4 flex justify-between items-center" onClick={() => setOpenId(open ? null : c.id)}>
                <div>
                  <div className="font-medium text-sm">{c.nombre}</div>
                  <div className="text-[12px] text-[#7A7263]">
                    {c.contacto}{c.telefono ? ` · ${c.telefono}` : ""}
                  </div>
                </div>
                {trabajosRelacionados.length > 0 && (
                  <div className="text-[11px] text-[#7A7263]">{trabajosRelacionados.length} trabajo{trabajosRelacionados.length === 1 ? "" : "s"}</div>
                )}
              </button>

              {open && (
                <div style={{ borderTop: `1px dashed ${LINE}` }} className="p-4 pt-3 space-y-2">
                  <div>
                    <label className="text-[11px] text-[#7A7263] block mb-0.5">Nombre</label>
                    <input className="ledger-input text-xs" value={c.nombre} onChange={(e) => update((d) => { d.clientes.find((x) => x.id === c.id).nombre = e.target.value; })} />
                  </div>
                  <div>
                    <label className="text-[11px] text-[#7A7263] block mb-0.5">Contacto / manager</label>
                    <input className="ledger-input text-xs" value={c.contacto} onChange={(e) => update((d) => { d.clientes.find((x) => x.id === c.id).contacto = e.target.value; })} />
                  </div>
                  <div>
                    <label className="text-[11px] text-[#7A7263] block mb-0.5">Teléfono</label>
                    <input className="ledger-input text-xs" value={c.telefono} onChange={(e) => update((d) => { d.clientes.find((x) => x.id === c.id).telefono = e.target.value; })} />
                  </div>
                  <div>
                    <label className="text-[11px] text-[#7A7263] block mb-0.5">Correo</label>
                    <input className="ledger-input text-xs" value={c.correo} onChange={(e) => update((d) => { d.clientes.find((x) => x.id === c.id).correo = e.target.value; })} />
                  </div>
                  <div>
                    <label className="text-[11px] text-[#7A7263] block mb-0.5">Dirección</label>
                    <input className="ledger-input text-xs" value={c.direccion} onChange={(e) => update((d) => { d.clientes.find((x) => x.id === c.id).direccion = e.target.value; })} />
                  </div>
                  <div>
                    <label className="text-[11px] text-[#7A7263] block mb-0.5">Notas</label>
                    <textarea className="ledger-input text-xs" rows={3} value={c.notas} onChange={(e) => update((d) => { d.clientes.find((x) => x.id === c.id).notas = e.target.value; })} />
                  </div>

                  {trabajosRelacionados.length > 0 && (
                    <>
                      <div className="stamp text-[12px] text-[#7A7263] mt-3 mb-1">TRABAJOS DE ESTE CLIENTE</div>
                      {trabajosRelacionados.map((t) => (
                        <div key={t.id} className="text-sm py-1 border-b last:border-0" style={{ borderColor: LINE }}>{t.apodo || t.nombre}</div>
                      ))}
                    </>
                  )}

                  <button
                    className="text-[11px] text-[#A13D2E] mt-2"
                    onClick={() => update((d) => { d.clientes = d.clientes.filter((x) => x.id !== c.id); })}
                  >
                    Eliminar cliente
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Nombre legible de un participante según su tipo (socio, empleado, o persona libre)
function nombreParticipante(data, p) {
  if (p.tipo === "socio") return data.socios.find((s) => s.id === p.ref)?.nombre || "—";
  if (p.tipo === "empleado") return data.empleados.find((e) => e.id === p.ref)?.nombre || "—";
  return p.ref;
}

function Bitacora({ data, update }) {
  const [form, setForm] = useState(null);
  const [nuevoParticipante, setNuevoParticipante] = useState("");
  const [filtroTrabajo, setFiltroTrabajo] = useState("");
  const [editandoId, setEditandoId] = useState(null);
  const [extraTemp, setExtraTemp] = useState("");
  const [editandoTextoId, setEditandoTextoId] = useState(null);
  const [textoTemp, setTextoTemp] = useState("");
  const [pagoAbiertoId, setPagoAbiertoId] = useState(null);
  const [pagoForm, setPagoForm] = useState({});
  const [pagoEditandoId, setPagoEditandoId] = useState(null);
  const [pagoEditForm, setPagoEditForm] = useState({});

  const addEntrada = () => {
    if (!form?.trabajoId || !form?.descripcion) return;
    update((d) => {
      d.bitacora.push({
        id: uid(),
        trabajoId: form.trabajoId,
        fecha: form.fecha || todayISO(),
        descripcion: form.descripcion,
        participantes: form.participantes || [],
        nominaIds: [],
      });
    });
    setForm(null);
    setNuevoParticipante("");
  };

  const toggleParticipanteForm = (tipo, ref) => {
    setForm((f) => {
      const lista = f.participantes || [];
      const existe = lista.some((p) => p.tipo === tipo && p.ref === ref);
      const nueva = existe
        ? lista.filter((p) => !(p.tipo === tipo && p.ref === ref))
        : [...lista, { tipo, ref, estado: "pendiente" }];
      return { ...f, participantes: nueva };
    });
  };

  const addExtraForm = () => {
    const nombre = nuevoParticipante.trim();
    if (!nombre) return;
    setForm((f) => ({ ...f, participantes: [...(f.participantes || []), { tipo: "extra", ref: nombre, estado: "pendiente" }] }));
    setNuevoParticipante("");
  };

  // --- Edición de una actividad ya guardada ---
  const toggleParticipanteGuardado = (bitId, tipo, ref) => {
    update((d) => {
      const entrada = d.bitacora.find((x) => x.id === bitId);
      const lista = entrada.participantes || [];
      const existe = lista.some((p) => p.tipo === tipo && p.ref === ref);
      entrada.participantes = existe
        ? lista.filter((p) => !(p.tipo === tipo && p.ref === ref))
        : [...lista, { tipo, ref, estado: "pendiente" }];
    });
  };

  // Quita un participante puntual (sirve también para los "huérfanos" sin nombre que quedaron de la migración vieja)
  const quitarParticipante = (bitId, tipo, ref) => {
    update((d) => {
      const entrada = d.bitacora.find((x) => x.id === bitId);
      entrada.participantes = (entrada.participantes || []).filter((p) => !(p.tipo === tipo && p.ref === ref));
    });
  };

  const addExtraGuardado = (bitId, nombre) => {
    if (!nombre.trim()) return;
    update((d) => {
      const entrada = d.bitacora.find((x) => x.id === bitId);
      entrada.participantes = [...(entrada.participantes || []), { tipo: "extra", ref: nombre.trim(), estado: "pendiente" }];
    });
  };

  const toggleEstadoParticipante = (bitId, tipo, ref) => {
    update((d) => {
      const entrada = d.bitacora.find((x) => x.id === bitId);
      const p = (entrada.participantes || []).find((x) => x.tipo === tipo && x.ref === ref);
      if (p) p.estado = p.estado === "completado" ? "pendiente" : "completado";
    });
  };

  const guardarPago = (bitId) => {
    if (!pagoForm.empleadoId || !pagoForm.monto) return;
    const nominaId = uid();
    update((d) => {
      d.nomina.push({
        id: nominaId,
        empleadoId: pagoForm.empleadoId,
        trabajoId: d.bitacora.find((x) => x.id === bitId).trabajoId,
        fecha: d.bitacora.find((x) => x.id === bitId).fecha,
        monto: Number(pagoForm.monto),
        pagadoPor: pagoForm.pagadoPor || "empresa",
        cuentaId: pagoForm.cuentaId || "",
        formaPago: pagoForm.formaPago || "efectivo",
        numeroCheque: pagoForm.formaPago === "cheque" ? (pagoForm.numeroCheque || "") : "",
        antesSociedad: !!pagoForm.antesSociedad,
        reembolsado: false,
      });
      const entrada = d.bitacora.find((x) => x.id === bitId);
      entrada.nominaIds = [...(entrada.nominaIds || []), nominaId];
      // marca a ese empleado como completado automáticamente, si estaba entre los participantes
      const p = (entrada.participantes || []).find((x) => x.tipo === "empleado" && x.ref === pagoForm.empleadoId);
      if (p) p.estado = "completado";
    });
    setPagoAbiertoId(null);
    setPagoForm({});
  };

  // Agrupamos por trabajo (cada grupo ordenado por fecha), y ordenamos los grupos por su actividad más reciente,
  // para que cada trabajo quede junto y separado visualmente del siguiente.
  const entradasOrdenadas = [...data.bitacora]
    .filter((b) => !filtroTrabajo || b.trabajoId === filtroTrabajo)
    .sort((a, b) => (a.fecha < b.fecha ? 1 : -1));

  const ultimaFechaPorTrabajo = {};
  entradasOrdenadas.forEach((b) => {
    if (!ultimaFechaPorTrabajo[b.trabajoId] || b.fecha > ultimaFechaPorTrabajo[b.trabajoId]) {
      ultimaFechaPorTrabajo[b.trabajoId] = b.fecha;
    }
  });

  const entradas = [...entradasOrdenadas].sort((a, b) => {
    if (a.trabajoId !== b.trabajoId) {
      return ultimaFechaPorTrabajo[b.trabajoId] < ultimaFechaPorTrabajo[a.trabajoId] ? -1 : 1;
    }
    return a.fecha < b.fecha ? 1 : -1;
  });

  return (
    <div>
      <SectionTitle sub="Qué se hizo cada día, quién participó, y el estado de cada quien por separado">Actividad diaria</SectionTitle>

      {data.trabajos.length > 0 && (
        <div className="card p-3 mb-4">
          <label className="text-[11px] text-[#7A7263] uppercase tracking-wide block mb-1">Ver actividad de:</label>
          <div className="flex items-center gap-2">
            <select className="ledger-input flex-1" value={filtroTrabajo} onChange={(e) => setFiltroTrabajo(e.target.value)}>
              <option value="">Todos los trabajos</option>
              {data.trabajos.map((t) => <option key={t.id} value={t.id}>{t.numeroTrabajo ? `#${t.numeroTrabajo} · ` : ""}{t.apodo || t.nombre}</option>)}
            </select>
            {filtroTrabajo && (
              <button className="text-[11px] text-[#7A7263] underline whitespace-nowrap" onClick={() => setFiltroTrabajo("")}>
                Quitar filtro
              </button>
            )}
          </div>
        </div>
      )}

      {data.trabajos.length === 0 ? (
        <div className="card p-4 mb-4">
          <p className="text-[13px] text-[#4A4238]">
            Antes de registrar actividad, agrega al menos un trabajo en la pestaña <b>Trabajos</b> — cada actividad tiene que estar ligada a uno.
          </p>
        </div>
      ) : !form ? (
        <button className="btn-primary mb-4" onClick={() => setForm({ fecha: todayISO(), participantes: [] })}>
          <Plus size={14} /> Registrar actividad
        </button>
      ) : (
        <div className="card p-4 mb-4 space-y-2">
          <select className="ledger-input" value={form.trabajoId || ""} onChange={(e) => setForm({ ...form, trabajoId: e.target.value })}>
            <option value="">Trabajo…</option>
            {data.trabajos.map((t) => <option key={t.id} value={t.id}>{t.apodo || t.nombre}</option>)}
          </select>
          <input className="ledger-input" type="date" value={form.fecha} onChange={(e) => setForm({ ...form, fecha: e.target.value })} />
          <textarea
            className="ledger-input"
            rows={3}
            placeholder="¿Qué se hizo hoy en este trabajo?"
            value={form.descripcion || ""}
            onChange={(e) => setForm({ ...form, descripcion: e.target.value })}
          />

          <div className="stamp text-[12px] text-[#7A7263] mt-2 mb-1">¿QUIÉN PARTICIPÓ?</div>
          <p className="text-[11px] text-[#7A7263] mb-1">Toca para agregar. Ya guardada la actividad, cada quien tiene su propio estado.</p>

          {data.socios.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-1">
              {data.socios.map((s) => {
                const selected = (form.participantes || []).some((p) => p.tipo === "socio" && p.ref === s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggleParticipanteForm("socio", s.id)}
                    className="text-xs px-2.5 py-1.5 border"
                    style={{
                      borderColor: selected ? AMBER : LINE,
                      background: selected ? "#F3EEE4" : "#fff",
                      color: selected ? "#1E2A38" : "#7A7263",
                    }}
                  >
                    {selected ? "✓ " : ""}{s.nombre}
                  </button>
                );
              })}
            </div>
          )}

          {data.empleados.length === 0 ? (
            <p className="text-[13px] text-[#7A7263] mb-2">
              Todavía no tienes empleados dados de alta. Ve a la pestaña <b>Nómina</b> → "+ Empleado" para agregarlos, y luego van a aparecer aquí para marcarlos.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2 mb-1">
              {data.empleados.map((emp) => {
                const selected = (form.participantes || []).some((p) => p.tipo === "empleado" && p.ref === emp.id);
                return (
                  <button
                    key={emp.id}
                    type="button"
                    onClick={() => toggleParticipanteForm("empleado", emp.id)}
                    className="text-xs px-2.5 py-1.5 border"
                    style={{
                      borderColor: selected ? AMBER : LINE,
                      background: selected ? "#F3EEE4" : "#fff",
                      color: selected ? "#1E2A38" : "#7A7263",
                    }}
                  >
                    {selected ? "✓ " : ""}{emp.nombre}
                  </button>
                );
              })}
            </div>
          )}

          {(form.participantes || []).filter((p) => p.tipo === "extra").length > 0 && (
            <div className="flex flex-wrap gap-2 mb-1">
              {form.participantes.filter((p) => p.tipo === "extra").map((p) => (
                <span key={p.ref} className="text-xs px-2.5 py-1.5 border flex items-center gap-1" style={{ borderColor: AMBER, background: "#F3EEE4", color: "#1E2A38" }}>
                  {p.ref}
                  <button type="button" onClick={() => toggleParticipanteForm("extra", p.ref)}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}

          <div className="flex gap-2 mb-2">
            <input
              className="ledger-input flex-1"
              placeholder="Otra persona (ej. tu nombre, alguien no registrado)"
              value={nuevoParticipante}
              onChange={(e) => setNuevoParticipante(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addExtraForm(); } }}
            />
            <button type="button" className="text-sm px-3 border" style={{ borderColor: LINE }} onClick={addExtraForm}>
              + Agregar
            </button>
          </div>

          <p className="text-[11px] text-[#7A7263]">
            Después de guardar, marcas a cada quien como Pendiente o Completado, y puedes registrar el pago de nómina de cada uno por separado.
          </p>

          <div className="flex gap-2">
            <button className="btn-primary" onClick={addEntrada}><Check size={14} /> Guardar</button>
            <button className="text-sm text-[#7A7263] px-2" onClick={() => setForm(null)}>Cancelar</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {entradas.length === 0 && <Empty text="Sin actividad registrada todavía." />}
        {entradas.map((b, i) => {
          const trab = data.trabajos.find((t) => t.id === b.trabajoId);
          const participantes = b.participantes || [];
          const pagosDeEstaActividad = (b.nominaIds || []).map((id) => data.nomina.find((n) => n.id === id)).filter(Boolean);
          const esNuevoGrupo = i === 0 || entradas[i - 1].trabajoId !== b.trabajoId;

          return (
            <React.Fragment key={b.id}>
              {esNuevoGrupo && (
                <div className="flex items-center gap-2 pt-3 pb-1 first:pt-0">
                  <span className="stamp text-[12px] text-[#1E2A38]">{trab?.apodo || trab?.nombre || "Sin trabajo"}</span>
                  {trab?.estado === "cerrado" && (
                    <span className="text-[9px] uppercase px-1.5 py-0.5" style={{ background: "#E1EEE6", color: GREEN }}>Concluido</span>
                  )}
                  <div className="flex-1 h-px" style={{ background: AMBER }} />
                </div>
              )}
            <div className="card p-4">
              <div className="flex justify-between items-start mb-1">
                <div className="font-medium text-sm">{trab?.apodo || trab?.nombre || "—"}</div>
                <div className="text-[11px] text-[#7A7263]">{fmtDate(b.fecha)}</div>
              </div>
              {editandoTextoId === b.id ? (
                <div className="mb-2">
                  <textarea
                    className="ledger-input text-sm w-full"
                    rows={3}
                    value={textoTemp}
                    onChange={(e) => setTextoTemp(e.target.value)}
                    autoFocus
                  />
                  <div className="flex gap-2 mt-1">
                    <button
                      type="button"
                      className="text-[11px] px-2 py-1 border flex items-center gap-1"
                      style={{ borderColor: GREEN, color: GREEN }}
                      onClick={() => {
                        update((d) => { d.bitacora.find((x) => x.id === b.id).descripcion = textoTemp; });
                        setEditandoTextoId(null);
                      }}
                    >
                      <Check size={12} /> Guardar
                    </button>
                    <button type="button" className="text-[11px] text-[#7A7263] underline" onClick={() => setEditandoTextoId(null)}>Cancelar</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2 mb-2">
                  <p className="text-sm text-[#4A4238]">{b.descripcion}</p>
                  <button
                    type="button"
                    title="Editar lo que se escribió"
                    className="text-[#7A7263] shrink-0"
                    onClick={() => { setEditandoTextoId(b.id); setTextoTemp(b.descripcion || ""); }}
                  >
                    <PenLine size={13} />
                  </button>
                </div>
              )}

              {/* Participantes con su propio estado — clic para Pendiente/Completado, X para quitar */}
              <div className="flex flex-wrap gap-1.5 mb-2">
                {participantes.map((p) => {
                  const completado = p.estado === "completado";
                  return (
                    <span
                      key={p.tipo + p.ref}
                      className="text-[11px] font-medium pl-2 pr-1 py-1 border flex items-center gap-1"
                      style={{
                        borderColor: completado ? GREEN : "#A13D2E",
                        background: completado ? "#DDEEDF" : "#F7DEDA",
                        color: completado ? GREEN : "#A13D2E",
                      }}
                    >
                      <button type="button" onClick={() => toggleEstadoParticipante(b.id, p.tipo, p.ref)}>
                        {nombreParticipante(data, p)} · {completado ? "Completado" : "Pendiente"}
                      </button>
                      <button
                        type="button"
                        title="Quitar de esta actividad"
                        onClick={() => quitarParticipante(b.id, p.tipo, p.ref)}
                        style={{ color: completado ? GREEN : "#A13D2E" }}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setEditandoId(editandoId === b.id ? null : b.id)}
                  className="text-[11px] text-[#7A7263] underline"
                >
                  {editandoId === b.id ? "listo" : "+ / - personas"}
                </button>
              </div>

              {editandoId === b.id && (
                <div className="border p-2 mb-2" style={{ borderColor: AMBER, background: "#FBF8F2" }}>
                  <div className="text-[10px] text-[#7A7263] uppercase mb-1">Agregar o quitar participantes</div>
                  {data.socios.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {data.socios.map((s) => {
                        const selected = participantes.some((p) => p.tipo === "socio" && p.ref === s.id);
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => toggleParticipanteGuardado(b.id, "socio", s.id)}
                            className="text-[11px] px-2 py-1 border"
                            style={{ borderColor: selected ? AMBER : LINE, background: selected ? "#F3EEE4" : "#fff", color: selected ? "#1E2A38" : "#7A7263" }}
                          >
                            {selected ? "✓ " : ""}{s.nombre}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {data.empleados.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {data.empleados.map((emp) => {
                        const selected = participantes.some((p) => p.tipo === "empleado" && p.ref === emp.id);
                        return (
                          <button
                            key={emp.id}
                            type="button"
                            onClick={() => toggleParticipanteGuardado(b.id, "empleado", emp.id)}
                            className="text-[11px] px-2 py-1 border"
                            style={{ borderColor: selected ? AMBER : LINE, background: selected ? "#F3EEE4" : "#fff", color: selected ? "#1E2A38" : "#7A7263" }}
                          >
                            {selected ? "✓ " : ""}{emp.nombre}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="flex gap-1.5">
                    <input
                      className="ledger-input flex-1 text-xs"
                      placeholder="Agregar otra persona"
                      value={extraTemp}
                      onChange={(e) => setExtraTemp(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addExtraGuardado(b.id, extraTemp); setExtraTemp(""); } }}
                    />
                    <button type="button" className="text-xs px-2 border" style={{ borderColor: LINE }} onClick={() => { addExtraGuardado(b.id, extraTemp); setExtraTemp(""); }}>
                      + Agregar
                    </button>
                  </div>
                </div>
              )}

              {pagosDeEstaActividad.length > 0 && (
                <div className="mb-2 space-y-1">
                  {pagosDeEstaActividad.map((pago) => {
                    const empleado = data.empleados.find((e) => e.id === pago.empleadoId);
                    if (pagoEditandoId === pago.id) {
                      return (
                        <div key={pago.id} className="border p-2 space-y-2" style={{ borderColor: AMBER, background: "#FBF8F2" }}>
                          <select className="ledger-input text-xs" value={pagoEditForm.empleadoId || ""} onChange={(e) => setPagoEditForm({ ...pagoEditForm, empleadoId: e.target.value })}>
                            <option value="">¿A quién se le pagó?</option>
                            {data.empleados.map((emp) => <option key={emp.id} value={emp.id}>{emp.nombre}</option>)}
                          </select>
                          <input className="ledger-input text-xs" type="number" placeholder="Monto" value={pagoEditForm.monto || ""} onChange={(e) => setPagoEditForm({ ...pagoEditForm, monto: e.target.value })} />
                          <select className="ledger-input text-xs" value={pagoEditForm.pagadoPor || "empresa"} onChange={(e) => setPagoEditForm({ ...pagoEditForm, pagadoPor: e.target.value })}>
                            <option value="empresa">Pagado desde cuenta de {data.empresaNombre}</option>
                            <option value="sindefinir">Aún no se sabe (se define cuando se pague)</option>
                            <option value="cliente">Lo pagó el cliente directamente (no afecta la ganancia)</option>
                            {data.socios.map((s) => <option key={s.id} value={s.id}>Pagado por {s.nombre} (a reembolsar)</option>)}
                          </select>
                          <select className="ledger-input text-xs" value={pagoEditForm.cuentaId || ""} onChange={(e) => setPagoEditForm({ ...pagoEditForm, cuentaId: e.target.value })}>
                            <option value="">Cuenta bancaria…</option>
                            {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                          </select>
                          <select className="ledger-input text-xs" value={pagoEditForm.formaPago || "efectivo"} onChange={(e) => setPagoEditForm({ ...pagoEditForm, formaPago: e.target.value })}>
                            <option value="efectivo">Efectivo</option>
                            <option value="cheque">Cheque</option>
                            <option value="zelle">Zelle</option>
                          </select>
                          {pagoEditForm.formaPago === "cheque" && (
                            <input className="ledger-input text-xs" placeholder="Número de cheque" value={pagoEditForm.numeroCheque || ""} onChange={(e) => setPagoEditForm({ ...pagoEditForm, numeroCheque: e.target.value })} />
                          )}
                          <div className="flex gap-2">
                            <button
                              className="btn-primary"
                              onClick={() => {
                                update((d) => {
                                  const p = d.nomina.find((x) => x.id === pago.id);
                                  p.empleadoId = pagoEditForm.empleadoId;
                                  p.monto = Number(pagoEditForm.monto);
                                  p.pagadoPor = pagoEditForm.pagadoPor || "empresa";
                                  p.cuentaId = pagoEditForm.cuentaId || "";
                                  p.formaPago = pagoEditForm.formaPago || "efectivo";
                                  p.numeroCheque = pagoEditForm.formaPago === "cheque" ? (pagoEditForm.numeroCheque || "") : "";
                                });
                                setPagoEditandoId(null);
                              }}
                            >
                              <Check size={13} /> Guardar
                            </button>
                            <button className="text-xs text-[#7A7263] px-2" onClick={() => setPagoEditandoId(null)}>Cancelar</button>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={pago.id} className="flex justify-between items-center text-[11px] text-[#7A7263]">
                        <span>
                          Pago: <b>{money(pago.monto)}</b> a {empleado?.nombre || "—"} · pagado por {pagadorNombre(data, pago.pagadoPor)}
                          {pago.numeroCheque ? ` · cheque #${pago.numeroCheque}` : pago.formaPago && pago.formaPago !== "efectivo" ? ` · ${pago.formaPago === "zelle" ? "Zelle" : pago.formaPago}` : ""}
                          {pago.reembolsado ? " · reembolsado" : ""}
                          {pago.antesSociedad && (
                            <span className="ml-1 text-[9px] uppercase px-1 py-0.5" style={{ background: "#FBE9D9", color: AMBER }}>Antes de la sociedad</span>
                          )}
                        </span>
                        <span className="flex items-center gap-2 shrink-0 ml-2">
                          <button
                            className="text-[#7A7263]"
                            title="Editar este pago"
                            onClick={() => {
                              setPagoEditForm({ empleadoId: pago.empleadoId, monto: pago.monto, pagadoPor: pago.pagadoPor || "empresa", cuentaId: pago.cuentaId || "", formaPago: pago.formaPago || (pago.numeroCheque ? "cheque" : "efectivo"), numeroCheque: pago.numeroCheque || "" });
                              setPagoEditandoId(pago.id);
                            }}
                          >
                            <PenLine size={12} />
                          </button>
                          <button
                            className="text-[#A13D2E]"
                            title="Eliminar este pago"
                            onClick={() =>
                              update((d) => {
                                d.nomina = d.nomina.filter((n) => n.id !== pago.id);
                                const entrada = d.bitacora.find((x) => x.id === b.id);
                                entrada.nominaIds = (entrada.nominaIds || []).filter((id) => id !== pago.id);
                              })
                            }
                          >
                            <Trash2 size={12} />
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {pagoAbiertoId === b.id ? (
                <div className="border p-2 mb-2 space-y-2" style={{ borderColor: AMBER, background: "#FBF8F2" }}>
                  <select className="ledger-input text-xs" value={pagoForm.empleadoId || ""} onChange={(e) => setPagoForm({ ...pagoForm, empleadoId: e.target.value })}>
                    <option value="">¿A quién se le pagó?</option>
                    {data.empleados.map((emp) => <option key={emp.id} value={emp.id}>{emp.nombre}</option>)}
                  </select>
                  <input className="ledger-input text-xs" type="number" placeholder="Monto" value={pagoForm.monto || ""} onChange={(e) => setPagoForm({ ...pagoForm, monto: e.target.value })} />
                  <select className="ledger-input text-xs" value={pagoForm.pagadoPor || "empresa"} onChange={(e) => setPagoForm({ ...pagoForm, pagadoPor: e.target.value })}>
                    <option value="empresa">Pagado desde cuenta de {data.empresaNombre}</option>
                    <option value="sindefinir">Aún no se sabe (se define cuando se pague)</option>
                    <option value="cliente">Lo pagó el cliente directamente (no afecta la ganancia)</option>
                    {data.socios.map((s) => <option key={s.id} value={s.id}>Pagado por {s.nombre} (a reembolsar)</option>)}
                  </select>
                  <select className="ledger-input text-xs" value={pagoForm.cuentaId || ""} onChange={(e) => setPagoForm({ ...pagoForm, cuentaId: e.target.value })}>
                    <option value="">Cuenta bancaria…</option>
                    {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
                  <select className="ledger-input text-xs" value={pagoForm.formaPago || "efectivo"} onChange={(e) => setPagoForm({ ...pagoForm, formaPago: e.target.value })}>
                    <option value="efectivo">Efectivo</option>
                    <option value="cheque">Cheque</option>
                    <option value="zelle">Zelle</option>
                  </select>
                  {pagoForm.formaPago === "cheque" && (
                    <input className="ledger-input text-xs" placeholder="Número de cheque" value={pagoForm.numeroCheque || ""} onChange={(e) => setPagoForm({ ...pagoForm, numeroCheque: e.target.value })} />
                  )}
                  <label className="flex items-center gap-1.5 text-[11px] text-[#7A7263] cursor-pointer">
                    <input type="checkbox" checked={!!pagoForm.antesSociedad} onChange={(e) => setPagoForm({ ...pagoForm, antesSociedad: e.target.checked })} />
                    Pagado con dinero de antes de la sociedad
                  </label>
                  <div className="flex gap-2">
                    <button className="btn-primary" onClick={() => guardarPago(b.id)}><Check size={13} /> Guardar pago</button>
                    <button className="text-xs text-[#7A7263] px-2" onClick={() => { setPagoAbiertoId(null); setPagoForm({}); }}>Cancelar</button>
                  </div>
                </div>
              ) : (
                <button
                  className="text-[11px] text-[#7A7263] underline mb-2"
                  onClick={() => { setPagoAbiertoId(b.id); setPagoForm({}); }}
                >
                  + Registrar pago de nómina
                </button>
              )}

              <div className="flex justify-end">
                <button
                  className="text-[11px] text-[#A13D2E]"
                  onClick={() => update((d) => { d.bitacora = d.bitacora.filter((x) => x.id !== b.id); })}
                >
                  Eliminar actividad
                </button>
              </div>
            </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

function Nomina({ data, update }) {
  const [empForm, setEmpForm] = useState(null);
  const [payForm, setPayForm] = useState(null);
  const [editandoPagoId, setEditandoPagoId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const turnoHoy = socioEnTurno(data, todayISO());

  const addEmpleado = () => {
    if (!empForm?.nombre) return;
    update((d) => d.empleados.push({ id: uid(), nombre: empForm.nombre, tipo: empForm.tipo || "planta", tarifa: Number(empForm.tarifa || 0) }));
    setEmpForm(null);
  };

  const addPago = () => {
    if (!payForm?.empleadoId || !payForm?.monto) return;
    update((d) =>
      d.nomina.push({
        id: uid(),
        empleadoId: payForm.empleadoId,
        trabajoId: payForm.trabajoId || "",
        fecha: payForm.fecha || todayISO(),
        monto: Number(payForm.monto),
        pagadoPor: payForm.pagadoPor || "empresa",
        cuentaId: payForm.cuentaId || "",
        formaPago: payForm.formaPago || "efectivo",
        numeroCheque: payForm.formaPago === "cheque" ? (payForm.numeroCheque || "") : "",
        antesSociedad: !!payForm.antesSociedad,
        estado: payForm.estado || "pagado",
        reembolsado: false,
      })
    );
    setPayForm(null);
  };

  const abrirPago = () => {
    const fecha = todayISO();
    const turno = socioEnTurno(data, fecha);
    setPayForm({ fecha, pagadoPor: turno || "empresa" });
  };

  const onFechaPago = (fecha) => {
    const turno = socioEnTurno(data, fecha);
    setPayForm((f) => ({ ...f, fecha, pagadoPor: turno || f.pagadoPor }));
  };

  return (
    <div>
      <SectionTitle sub="Empleados de planta y por día, y los pagos que se les hacen">Nómina</SectionTitle>

      {(() => {
        const pendientesPorEmpleado = {};
        data.nomina.filter((n) => n.estado === "pendiente").forEach((n) => {
          if (!pendientesPorEmpleado[n.empleadoId]) pendientesPorEmpleado[n.empleadoId] = { monto: 0, cantidad: 0 };
          pendientesPorEmpleado[n.empleadoId].monto += Number(n.monto);
          pendientesPorEmpleado[n.empleadoId].cantidad += 1;
        });
        const lista = Object.entries(pendientesPorEmpleado)
          .map(([empId, info]) => ({ nombre: data.empleados.find((e) => e.id === empId)?.nombre || "—", ...info }))
          .sort((a, b) => b.monto - a.monto);
        const totalPendiente = lista.reduce((s, l) => s + l.monto, 0);
        if (lista.length === 0) return null;
        return (
          <div className="card p-4 mb-4" style={{ borderLeft: "4px solid #A13D2E" }}>
            <div className="flex justify-between items-baseline mb-2">
              <div className="stamp text-[13px] text-[#A13D2E]">PENDIENTE DE PAGO</div>
              <div className="mono text-lg font-bold" style={{ color: "#A13D2E" }}>{money(totalPendiente)}</div>
            </div>
            <div className="space-y-1.5">
              {lista.map((l, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span>{l.nombre} <span className="text-[11px] text-[#7A7263]">({l.cantidad} pago{l.cantidad !== 1 ? "s" : ""})</span></span>
                  <span className="mono">{money(l.monto)}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {data.rotacionNomina?.activa && (
        <div className="card p-3 mb-4 flex items-center justify-between" style={{ borderLeft: `4px solid ${AMBER}` }}>
          <span className="text-sm">Este mes le toca pagar la nómina a</span>
          <span className="stamp text-[13px]">{pagadorNombre(data, turnoHoy)}</span>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="card p-4">
          <div className="stamp text-[13px] text-[#7A7263] mb-3">EMPLEADOS</div>
          <div className="space-y-1 mb-3">
            {data.empleados.length === 0 && <Empty text="Sin empleados registrados." />}
            {data.empleados.map((e) => (
              <div key={e.id} className="flex justify-between items-center text-sm py-1 border-b last:border-0" style={{ borderColor: LINE }}>
                <span>{e.nombre} <span className="text-[11px] text-[#7A7263]">({e.tipo === "planta" ? "planta" : "por día"})</span></span>
                <div className="flex items-center gap-2">
                  <span className="mono">{money(e.tarifa)}</span>
                  <button
                    onClick={() => update((d) => { d.empleados = d.empleados.filter((x) => x.id !== e.id); })}
                    className="text-[#A13D2E]"
                    title="Eliminar empleado"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          {!empForm ? (
            <button className="btn-primary" onClick={() => setEmpForm({})}><Plus size={14} /> Empleado</button>
          ) : (
            <div className="space-y-2">
              <input className="ledger-input" placeholder="Nombre" value={empForm.nombre || ""} onChange={(e) => setEmpForm({ ...empForm, nombre: e.target.value })} />
              <select className="ledger-input" value={empForm.tipo || "planta"} onChange={(e) => setEmpForm({ ...empForm, tipo: e.target.value })}>
                <option value="planta">Planta (salario fijo)</option>
                <option value="dia">Por día</option>
              </select>
              <input className="ledger-input" type="number" placeholder="Tarifa ($ salario o jornal)" value={empForm.tarifa || ""} onChange={(e) => setEmpForm({ ...empForm, tarifa: e.target.value })} />
              <div className="flex gap-2">
                <button className="btn-primary" onClick={addEmpleado}><Check size={14} /> Guardar</button>
                <button className="text-sm text-[#7A7263] px-2" onClick={() => setEmpForm(null)}>Cancelar</button>
              </div>
            </div>
          )}
        </div>

        <div className="card p-4">
          <div className="stamp text-[13px] text-[#7A7263] mb-3">REGISTRAR PAGO</div>
          {!payForm ? (
            <button className="btn-primary" onClick={abrirPago} disabled={data.empleados.length === 0}>
              <Plus size={14} /> Pago
            </button>
          ) : (
            <div className="space-y-2">
              <select className="ledger-input" value={payForm.empleadoId || ""} onChange={(e) => setPayForm({ ...payForm, empleadoId: e.target.value })}>
                <option value="">Empleado…</option>
                {data.empleados.map((e) => <option key={e.id} value={e.id}>{e.nombre}</option>)}
              </select>
              <select
                className="ledger-input"
                value={payForm.trabajoId || ""}
                onChange={(e) => {
                  const trabajoId = e.target.value;
                  const turnoTrabajo = socioTurnoNominaTrabajo(data, trabajoId);
                  setPayForm({ ...payForm, trabajoId, pagadoPor: turnoTrabajo || payForm.pagadoPor });
                }}
              >
                <option value="">Trabajo (opcional)…</option>
                {data.trabajos.map((t) => <option key={t.id} value={t.id}>{t.apodo || t.nombre}</option>)}
              </select>
              {payForm.trabajoId && socioTurnoNominaTrabajo(data, payForm.trabajoId) && (
                <p className="text-[11px] text-[#7A7263]">
                  Le toca pagar este pago a <b>{pagadorNombre(data, socioTurnoNominaTrabajo(data, payForm.trabajoId))}</b> (se alterna con cada pago de nómina de este trabajo)
                </p>
              )}
              <input className="ledger-input" type="number" placeholder="Monto" value={payForm.monto || ""} onChange={(e) => setPayForm({ ...payForm, monto: e.target.value })} />
              <input className="ledger-input" type="date" value={payForm.fecha} onChange={(e) => onFechaPago(e.target.value)} />
              <div className="stamp text-[11px] text-[#7A7263] mt-1">ESTADO DEL PAGO</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPayForm({ ...payForm, estado: "pendiente" })}
                  className="flex-1 text-xs py-1.5 border font-medium"
                  style={{
                    borderColor: (payForm.estado || "pagado") === "pendiente" ? "#A13D2E" : LINE,
                    background: (payForm.estado || "pagado") === "pendiente" ? "#F7DEDA" : "#fff",
                    color: (payForm.estado || "pagado") === "pendiente" ? "#A13D2E" : "#7A7263",
                  }}
                >
                  Pendiente — se debe, no se ha pagado
                </button>
                <button
                  type="button"
                  onClick={() => setPayForm({ ...payForm, estado: "pagado" })}
                  className="flex-1 text-xs py-1.5 border font-medium"
                  style={{
                    borderColor: (payForm.estado || "pagado") === "pagado" ? GREEN : LINE,
                    background: (payForm.estado || "pagado") === "pagado" ? "#DDEEDF" : "#fff",
                    color: (payForm.estado || "pagado") === "pagado" ? GREEN : "#7A7263",
                  }}
                >
                  Ya pagado
                </button>
              </div>
              <select className="ledger-input" value={payForm.pagadoPor || "empresa"} onChange={(e) => setPayForm({ ...payForm, pagadoPor: e.target.value })}>
                <option value="empresa">Pagado desde cuenta de {data.empresaNombre}</option>
                <option value="sindefinir">Aún no se sabe (se define cuando se pague)</option>
                <option value="cliente">Lo pagó el cliente directamente (no afecta la ganancia)</option>
                {data.socios.map((s) => <option key={s.id} value={s.id}>Pagado por {s.nombre} (a reembolsar){data.rotacionNomina?.activa && s.id === socioEnTurno(data, payForm.fecha) ? " · turno del mes" : ""}</option>)}
              </select>
              <select className="ledger-input" value={payForm.cuentaId || ""} onChange={(e) => setPayForm({ ...payForm, cuentaId: e.target.value })}>
                <option value="">Cuenta bancaria…</option>
                {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
              <select className="ledger-input" value={payForm.formaPago || "efectivo"} onChange={(e) => setPayForm({ ...payForm, formaPago: e.target.value })}>
                <option value="efectivo">Efectivo</option>
                <option value="cheque">Cheque</option>
                <option value="zelle">Zelle</option>
              </select>
              {payForm.formaPago === "cheque" && (
                <input className="ledger-input" placeholder="Número de cheque" value={payForm.numeroCheque || ""} onChange={(e) => setPayForm({ ...payForm, numeroCheque: e.target.value })} />
              )}
              <label className="flex items-center gap-1.5 text-[12px] text-[#7A7263] cursor-pointer">
                <input type="checkbox" checked={!!payForm.antesSociedad} onChange={(e) => setPayForm({ ...payForm, antesSociedad: e.target.checked })} />
                Pagado con dinero de antes de la sociedad
              </label>
              <div className="flex gap-2">
                <button className="btn-primary" onClick={addPago}><Check size={14} /> Guardar</button>
                <button className="text-sm text-[#7A7263] px-2" onClick={() => setPayForm(null)}>Cancelar</button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card p-4 mt-4">
        <div className="stamp text-[13px] text-[#7A7263] mb-3">HISTORIAL DE PAGOS</div>
        {data.nomina.length === 0 && <Empty text="Sin pagos registrados." />}
        {[...data.nomina].sort((a, b) => (a.fecha < b.fecha ? 1 : -1)).map((n) => {
          const emp = data.empleados.find((e) => e.id === n.empleadoId);
          const trab = data.trabajos.find((t) => t.id === n.trabajoId);
          const editando = editandoPagoId === n.id;
          return (
            <div key={n.id} className="py-1.5 border-b last:border-0" style={{ borderColor: LINE }}>
              {editando ? (
                <div className="space-y-2 py-1">
                  <select className="ledger-input text-xs" value={editForm.empleadoId || ""} onChange={(e) => setEditForm({ ...editForm, empleadoId: e.target.value })}>
                    <option value="">Empleado…</option>
                    {data.empleados.map((e) => <option key={e.id} value={e.id}>{e.nombre}</option>)}
                  </select>
                  <select className="ledger-input text-xs" value={editForm.trabajoId || ""} onChange={(e) => setEditForm({ ...editForm, trabajoId: e.target.value })}>
                    <option value="">Trabajo (opcional)…</option>
                    {data.trabajos.map((t) => <option key={t.id} value={t.id}>{t.apodo || t.nombre}</option>)}
                  </select>
                  <input className="ledger-input text-xs" type="number" placeholder="Monto" value={editForm.monto || ""} onChange={(e) => setEditForm({ ...editForm, monto: e.target.value })} />
                  <input className="ledger-input text-xs" type="date" value={editForm.fecha || ""} onChange={(e) => setEditForm({ ...editForm, fecha: e.target.value })} />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setEditForm({ ...editForm, estado: "pendiente" })}
                      className="flex-1 text-xs py-1.5 border font-medium"
                      style={{
                        borderColor: (editForm.estado || "pagado") === "pendiente" ? "#A13D2E" : LINE,
                        background: (editForm.estado || "pagado") === "pendiente" ? "#F7DEDA" : "#fff",
                        color: (editForm.estado || "pagado") === "pendiente" ? "#A13D2E" : "#7A7263",
                      }}
                    >
                      Pendiente
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditForm({ ...editForm, estado: "pagado" })}
                      className="flex-1 text-xs py-1.5 border font-medium"
                      style={{
                        borderColor: (editForm.estado || "pagado") === "pagado" ? GREEN : LINE,
                        background: (editForm.estado || "pagado") === "pagado" ? "#DDEEDF" : "#fff",
                        color: (editForm.estado || "pagado") === "pagado" ? GREEN : "#7A7263",
                      }}
                    >
                      Pagado
                    </button>
                  </div>
                  <select className="ledger-input text-xs" value={editForm.pagadoPor || "empresa"} onChange={(e) => setEditForm({ ...editForm, pagadoPor: e.target.value })}>
                    <option value="empresa">Pagado desde cuenta de {data.empresaNombre}</option>
                    <option value="sindefinir">Aún no se sabe (se define cuando se pague)</option>
                    <option value="cliente">Lo pagó el cliente directamente (no afecta la ganancia)</option>
                    {data.socios.map((s) => <option key={s.id} value={s.id}>Pagado por {s.nombre} (a reembolsar)</option>)}
                  </select>
                  <select className="ledger-input text-xs" value={editForm.cuentaId || ""} onChange={(e) => setEditForm({ ...editForm, cuentaId: e.target.value })}>
                    <option value="">Cuenta bancaria…</option>
                    {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
                  <select className="ledger-input text-xs" value={editForm.formaPago || "efectivo"} onChange={(e) => setEditForm({ ...editForm, formaPago: e.target.value })}>
                    <option value="efectivo">Efectivo</option>
                    <option value="cheque">Cheque</option>
                    <option value="zelle">Zelle</option>
                  </select>
                  {editForm.formaPago === "cheque" && (
                    <input className="ledger-input text-xs" placeholder="Número de cheque" value={editForm.numeroCheque || ""} onChange={(e) => setEditForm({ ...editForm, numeroCheque: e.target.value })} />
                  )}
                  <div className="flex gap-2">
                    <button
                      className="btn-primary"
                      onClick={() => {
                        update((d) => {
                          const pago = d.nomina.find((x) => x.id === n.id);
                          pago.empleadoId = editForm.empleadoId;
                          pago.trabajoId = editForm.trabajoId || "";
                          pago.monto = Number(editForm.monto);
                          pago.fecha = editForm.fecha;
                          pago.pagadoPor = editForm.pagadoPor || "empresa";
                          pago.cuentaId = editForm.cuentaId || "";
                          pago.formaPago = editForm.formaPago || "efectivo";
                          pago.numeroCheque = editForm.formaPago === "cheque" ? (editForm.numeroCheque || "") : "";
                          pago.estado = editForm.estado || "pagado";
                        });
                        setEditandoPagoId(null);
                      }}
                    >
                      <Check size={13} /> Guardar
                    </button>
                    <button className="text-xs text-[#7A7263] px-2" onClick={() => setEditandoPagoId(null)}>Cancelar</button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-between items-center text-sm">
                  <div>
                    <div>{emp?.nombre || "—"} <span className="text-[11px] text-[#7A7263]">{trab ? `· ${trab.apodo || trab.nombre}` : ""}</span></div>
                    <div className="text-[11px] text-[#7A7263]">
                      {fmtDate(n.fecha)} · pagado por {pagadorNombre(data, n.pagadoPor)}{n.numeroCheque ? ` · cheque #${n.numeroCheque}` : n.formaPago && n.formaPago !== "efectivo" ? ` · ${n.formaPago === "zelle" ? "Zelle" : n.formaPago}` : ""}{n.reembolsado ? " · reembolsado" : ""}
                      {n.antesSociedad && (
                        <span className="ml-1 text-[9px] uppercase px-1 py-0.5" style={{ background: "#FBE9D9", color: AMBER }}>Antes de la sociedad</span>
                      )}
                    </div>
                    <button
                      className="text-[11px] font-medium px-2 py-0.5 border mt-1"
                      style={{
                        borderColor: n.estado === "pendiente" ? "#A13D2E" : GREEN,
                        background: n.estado === "pendiente" ? "#F7DEDA" : "#DDEEDF",
                        color: n.estado === "pendiente" ? "#A13D2E" : GREEN,
                      }}
                      onClick={() => update((d) => {
                        const pago = d.nomina.find((x) => x.id === n.id);
                        pago.estado = pago.estado === "pendiente" ? "pagado" : "pendiente";
                      })}
                    >
                      {n.estado === "pendiente" ? "Pendiente" : "Pagado"} · tocar para cambiar
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="mono">{money(n.monto)}</span>
                    <button
                      className="text-[#7A7263]"
                      title="Editar pago"
                      onClick={() => {
                        setEditForm({ empleadoId: n.empleadoId, trabajoId: n.trabajoId || "", monto: n.monto, fecha: n.fecha, pagadoPor: n.pagadoPor || "empresa", cuentaId: n.cuentaId || "", formaPago: n.formaPago || (n.numeroCheque ? "cheque" : "efectivo"), numeroCheque: n.numeroCheque || "", estado: n.estado || "pagado" });
                        setEditandoPagoId(n.id);
                      }}
                    >
                      <PenLine size={13} />
                    </button>
                    <button
                      className="text-[#A13D2E]"
                      title="Eliminar pago"
                      onClick={() => update((d) => { d.nomina = d.nomina.filter((x) => x.id !== n.id); })}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Materiales ---------------- */
function Materiales({ data, update, onViewPhoto }) {
  const [form, setForm] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [scan, setScan] = useState(null);
  const [devolucionId, setDevolucionId] = useState(null);
  const [devolucionMonto, setDevolucionMonto] = useState("");
  const [devolucionSeleccion, setDevolucionSeleccion] = useState({});
  const [devolucionFoto, setDevolucionFoto] = useState(null);
  const [devolucionImpuesto, setDevolucionImpuesto] = useState("");
  const [ultimaFotoDevolucion, setUltimaFotoDevolucion] = useState(null);
  const [devolucionFotoSubiendo, setDevolucionFotoSubiendo] = useState(false);
  const [devolucionEscaneando, setDevolucionEscaneando] = useState(false);
  const [devolucionEscaneoError, setDevolucionEscaneoError] = useState("");
  const [editandoMaterialId, setEditandoMaterialId] = useState(null);
  const [editMaterialForm, setEditMaterialForm] = useState({});
  const [mostrarGaleria, setMostrarGaleria] = useState(false);
  // scan: { status: 'loading'|'review'|'error', foto, tienda, fecha, items:[], trabajoId, pagadoPor, empleadoPagadorId, cuentaId, errorMsg }

  // Agrupa los materiales por facturaId (los que vinieron juntos de un escaneo) — los sueltos quedan cada uno en su propio "grupo" de 1.
  // Después, esos grupos se organizan por trabajo (número de trabajo primero, los sin número al final,
  // y los sin trabajo asignado al final de todos), y dentro de cada trabajo se ordenan por fecha, del más reciente al más viejo.
  const gruposMateriales = useMemo(() => {
    const porFactura = {};
    const sueltos = [];
    data.materiales.forEach((m) => {
      if (m.facturaId) {
        if (!porFactura[m.facturaId]) porFactura[m.facturaId] = [];
        porFactura[m.facturaId].push(m);
      } else {
        sueltos.push(m);
      }
    });
    const grupos = [
      ...Object.entries(porFactura).map(([facturaId, items]) => ({ facturaId, items, fechaOrden: items[0]?.fecha || "", trabajoId: items[0]?.trabajoId || "" })),
      ...sueltos.map((m) => ({ facturaId: null, items: [m], fechaOrden: m.fecha, trabajoId: m.trabajoId || "" })),
    ];
    return grupos.sort((a, b) => (a.fechaOrden < b.fechaOrden ? 1 : -1));
  }, [data.materiales]);

  // Los mismos grupos de arriba, pero organizados por trabajo para la vista agrupada.
  const gruposPorTrabajo = useMemo(() => {
    const porTrabajo = {};
    gruposMateriales.forEach((g) => {
      const key = g.trabajoId || "__sin_trabajo__";
      if (!porTrabajo[key]) porTrabajo[key] = [];
      porTrabajo[key].push(g);
    });
    const bloques = Object.entries(porTrabajo).map(([trabajoId, grupos]) => {
      const trab = trabajoId !== "__sin_trabajo__" ? data.trabajos.find((t) => t.id === trabajoId) : null;
      return { trabajoId: trabajoId === "__sin_trabajo__" ? "" : trabajoId, trab, grupos, fechaOrden: grupos[0]?.fechaOrden || "" };
    });
    // Ordena los bloques por número de trabajo (numérico); los sin número, y los sin trabajo asignado, van al final.
    bloques.sort((a, b) => {
      if (!a.trabajoId && !b.trabajoId) return 0;
      if (!a.trabajoId) return 1;
      if (!b.trabajoId) return -1;
      const na = parseInt(a.trab?.numeroTrabajo, 10);
      const nb = parseInt(b.trab?.numeroTrabajo, 10);
      const va = isNaN(na) ? Infinity : na;
      const vb = isNaN(nb) ? Infinity : nb;
      if (va !== vb) return va - vb;
      return (a.fechaOrden < b.fechaOrden ? 1 : -1);
    });
    return bloques;
  }, [gruposMateriales, data.trabajos]);

  const addMaterial = () => {
    if (!form?.descripcion || !form?.monto) return;
    const pagadoPorFinal = form.pagadoPor === "empleado" ? `empleado:${form.empleadoPagadorId}` : (form.pagadoPor || "empresa");
    update((d) =>
      d.materiales.push({
        id: uid(),
        trabajoId: form.trabajoId || "",
        descripcion: form.descripcion,
        monto: Number(form.monto),
        fecha: form.fecha || todayISO(),
        pagadoPor: pagadoPorFinal,
        cuentaId: form.cuentaId || "",
        numeroCheque: form.numeroCheque || "",
        numeroInvoice: form.numeroInvoice || "",
        reembolsado: false,
        fotos: form.fotos || [],
      })
    );
    setForm(null);
  };

  const handleFoto = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploading(true);
    try {
      const nuevasFotos = [];
      for (const file of files) {
        const dataUrl = await compressImage(file);
        nuevasFotos.push(await subirFoto(dataUrl));
      }
      setForm((f) => ({ ...f, fotos: [...(f.fotos || []), ...nuevasFotos] }));
    } catch {
      // si falla la compresión simplemente no se adjunta
    }
    setUploading(false);
    e.target.value = "";
  };

  const quitarFotoForm = (idx) => {
    setForm((f) => ({ ...f, fotos: (f.fotos || []).filter((_, i) => i !== idx) }));
  };

  const handleEscaneo = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setScan({ status: "loading" });
    try {
      const fotosLocal = [];
      for (const file of files) {
        fotosLocal.push(await compressImage(file, 1200, 0.6));
      }
      const parsed = await extraerFacturaConIA(fotosLocal);
      // Subimos las fotos a Storage después de mandarlas a la IA (la IA necesita la imagen real, no un link)
      const fotos = await Promise.all(fotosLocal.map((f) => subirFoto(f)));
      setScan({
        status: "review",
        fotos,
        tienda: parsed.tienda || "",
        fecha: parsed.fecha || todayISO(),
        impuesto: parsed.impuesto ?? "",
        items: parsed.items.map((it) => ({
          id: uid(),
          descripcion: it.descripcion || "",
          numeroProducto: it.numeroProducto || "",
          cantidad: it.cantidad ?? 1,
          importe: it.importe ?? 0,
        })),
        trabajoId: "",
        pagadoPor: "empresa",
        empleadoPagadorId: "",
        cuentaId: "",
      });
    } catch (err) {
      setScan({ status: "error", errorMsg: "No pude leer la factura bien. Intenta con más luz o registra manualmente." });
    }
    e.target.value = "";
  };

  const guardarEscaneo = () => {
    if (!scan || scan.items.length === 0) return;
    const pagadoPorFinal = scan.pagadoPor === "empleado" ? `empleado:${scan.empleadoPagadorId}` : scan.pagadoPor;
    // Todos los artículos de esta factura comparten el mismo facturaId, y la(s) foto(s) se guardan
    // UNA sola vez (en el primer artículo) — así evitamos duplicar las fotos en cada renglón,
    // lo cual hacía que el archivo pesara demasiado y el guardado fallara en facturas con muchos artículos.
    const facturaId = uid();
    update((d) => {
      scan.items.forEach((it, idx) => {
        const etiqueta = it.numeroProducto ? `${it.descripcion} (#${it.numeroProducto})` : it.descripcion;
        d.materiales.push({
          id: uid(),
          facturaId,
          trabajoId: scan.trabajoId || "",
          descripcion: it.cantidad && it.cantidad !== 1 ? `${etiqueta} x${it.cantidad}` : etiqueta,
          monto: Number(it.importe) || 0,
          fecha: scan.fecha || todayISO(),
          pagadoPor: pagadoPorFinal,
          cuentaId: scan.cuentaId || "",
          reembolsado: false,
          fotos: idx === 0 ? (scan.fotos || []) : [],
          impuestoFactura: idx === 0 ? (Number(scan.impuesto) || 0) : 0,
          numeroCheque: idx === 0 ? (scan.numeroCheque || "") : "",
          numeroInvoice: idx === 0 ? (scan.numeroInvoice || "") : "",
          numeroProducto: it.numeroProducto || "",
          cantidad: it.cantidad || 1,
        });
      });
    });
    setScan(null);
  };

  const updateItem = (id, field, value) => {
    setScan((s) => ({ ...s, items: s.items.map((it) => (it.id === id ? { ...it, [field]: value } : it)) }));
  };

  const totalEscaneo = scan?.items?.reduce((s, it) => s + (Number(it.importe) || 0), 0) || 0;

  return (
    <div>
      <SectionTitle sub="Compras de materiales, asignadas a cada trabajo — con foto de la factura">Materiales</SectionTitle>

      {!form && !scan && (
        <div className="flex flex-wrap gap-2 mb-4">
          <label className="btn-primary cursor-pointer">
            <Sparkles size={15} /> Escanear factura (IA)
            <input type="file" accept="image/*" multiple className="hidden" onChange={handleEscaneo} />
          </label>
          <button
            className="text-sm flex items-center gap-1 px-3 border"
            style={{ borderColor: LINE }}
            onClick={() => setForm({ fecha: todayISO() })}
          >
            <PenLine size={14} /> Captura manual
          </button>
          <button
            className="text-sm flex items-center gap-1 px-3 border"
            style={{ borderColor: LINE }}
            onClick={() => setMostrarGaleria(true)}
          >
            <Camera size={14} /> Ver fotos por trabajo
          </button>
        </div>
      )}
      {!form && !scan && (
        <p className="text-[11px] text-[#7A7263] -mt-3 mb-4">Si la factura tiene varias hojas, selecciona todas las fotos juntas al escanear — se leen como una sola.</p>
      )}

      {/* ---- Flujo de escaneo con IA ---- */}
      {scan?.status === "loading" && (
        <div className="card p-6 mb-4 flex flex-col items-center gap-2 text-center">
          <Loader2 className="animate-spin text-[#7A7263]" size={26} />
          <div className="text-sm text-[#4A4238]">Leyendo la factura…</div>
        </div>
      )}

      {scan?.status === "error" && (
        <div className="card p-4 mb-4">
          <p className="text-sm text-[#A13D2E] mb-3">{scan.errorMsg}</p>
          <button className="text-sm text-[#7A7263] underline" onClick={() => setScan(null)}>Cerrar</button>
        </div>
      )}

      {scan?.status === "review" && (
        <div className="card p-4 mb-4">
          <div className="flex gap-3 mb-3">
            {scan.fotos?.length > 0 && (
              <div className="flex gap-1 shrink-0">
                {scan.fotos.map((f, i) => (
                  <img key={i} src={f} alt={`Página ${i + 1}`} className="w-16 h-16 object-cover border" style={{ borderColor: LINE }} />
                ))}
              </div>
            )}
            <div className="flex-1 space-y-2">
              <input className="ledger-input" placeholder="Tienda" value={scan.tienda} onChange={(e) => setScan({ ...scan, tienda: e.target.value })} />
              <input className="ledger-input" type="date" value={scan.fecha} onChange={(e) => setScan({ ...scan, fecha: e.target.value })} />
            </div>
          </div>

          <div className="stamp text-[12px] text-[#7A7263] mb-2">RENGLONES DETECTADOS · revisa antes de guardar</div>
          <div className="space-y-2 mb-2">
            {scan.items.map((it) => (
              <div key={it.id} className="border p-2" style={{ borderColor: LINE }}>
                <input className="ledger-input mb-1 text-sm" placeholder="Descripción" value={it.descripcion} onChange={(e) => updateItem(it.id, "descripcion", e.target.value)} />
                <div className="grid grid-cols-3 gap-1">
                  <input className="ledger-input text-xs" placeholder="# producto" value={it.numeroProducto} onChange={(e) => updateItem(it.id, "numeroProducto", e.target.value)} />
                  <input className="ledger-input text-xs" type="number" placeholder="Cant." value={it.cantidad} onChange={(e) => updateItem(it.id, "cantidad", e.target.value)} />
                  <input className="ledger-input text-xs" type="number" placeholder="Importe" value={it.importe} onChange={(e) => updateItem(it.id, "importe", e.target.value)} />
                </div>
                <button className="text-[11px] text-[#A13D2E] mt-1" onClick={() => setScan({ ...scan, items: scan.items.filter((x) => x.id !== it.id) })}>Quitar renglón</button>
              </div>
            ))}
          </div>
          <button
            className="text-[12px] text-[#7A7263] underline mb-3"
            onClick={() => setScan({ ...scan, items: [...scan.items, { id: uid(), descripcion: "", numeroProducto: "", cantidad: 1, importe: 0 }] })}
          >
            + Agregar renglón que faltó
          </button>

          <Row label="Total detectado" value={money(totalEscaneo)} bold />

          <div className="mt-2">
            <label className="text-[11px] text-[#7A7263] block mb-0.5">Impuesto (tax) de esta factura</label>
            <input
              type="number"
              className="ledger-input"
              placeholder="0.00"
              value={scan.impuesto}
              onChange={(e) => setScan({ ...scan, impuesto: e.target.value })}
            />
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-[#7A7263] block mb-0.5">Número de cheque (si aplica)</label>
              <input
                className="ledger-input"
                placeholder="Ej. 1042"
                value={scan.numeroCheque || ""}
                onChange={(e) => setScan({ ...scan, numeroCheque: e.target.value })}
              />
            </div>
            <div>
              <label className="text-[11px] text-[#7A7263] block mb-0.5">Número de invoice</label>
              <input
                className="ledger-input"
                placeholder="Si el recibo trae uno"
                value={scan.numeroInvoice || ""}
                onChange={(e) => setScan({ ...scan, numeroInvoice: e.target.value })}
              />
            </div>
          </div>

          <div className="stamp text-[12px] text-[#7A7263] mt-3 mb-2">DATOS DE LA COMPRA</div>
          <div className="space-y-2">
            <select
              className="ledger-input"
              value={scan.trabajoId}
              onChange={(e) => {
                const trabajoId = e.target.value;
                const turno = socioTurnoMaterial(data, trabajoId);
                setScan({ ...scan, trabajoId, pagadoPor: turno || scan.pagadoPor });
              }}
            >
              <option value="">Trabajo…</option>
              {data.trabajos.map((t) => <option key={t.id} value={t.id}>{t.apodo || t.nombre}</option>)}
            </select>
            {scan.trabajoId && socioTurnoMaterial(data, scan.trabajoId) && (
              <p className="text-[11px] text-[#7A7263]">
                Le toca pagar esta factura a <b>{pagadorNombre(data, socioTurnoMaterial(data, scan.trabajoId))}</b> (se alterna con cada factura de este trabajo)
              </p>
            )}
            <select className="ledger-input" value={scan.pagadoPor} onChange={(e) => setScan({ ...scan, pagadoPor: e.target.value })}>
              <option value="empresa">Pagado desde cuenta de {data.empresaNombre}</option>
              <option value="cliente">Lo pagó la empresa que nos contrató (no afecta la ganancia)</option>
              {data.socios.map((s) => <option key={s.id} value={s.id}>Pagado por {s.nombre} (a reembolsar)</option>)}
              <option value="empleado">Lo pagó un trabajador (a reembolsar)</option>
            </select>
            {scan.pagadoPor === "empleado" && (
              <select className="ledger-input" value={scan.empleadoPagadorId} onChange={(e) => setScan({ ...scan, empleadoPagadorId: e.target.value })}>
                <option value="">¿Qué trabajador?</option>
                {data.empleados.map((emp) => <option key={emp.id} value={emp.id}>{emp.nombre}</option>)}
              </select>
            )}
            {scan.pagadoPor !== "cliente" && (
              <select className="ledger-input" value={scan.cuentaId} onChange={(e) => setScan({ ...scan, cuentaId: e.target.value })}>
                <option value="">Cuenta bancaria…</option>
                {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            )}
          </div>

          <div className="flex gap-2 mt-3">
            <button className="btn-primary" onClick={guardarEscaneo}>
              <Check size={14} /> Guardar {scan.items.length} material{scan.items.length === 1 ? "" : "es"}
            </button>
            <button className="text-sm text-[#7A7263] px-2" onClick={() => setScan(null)}>Cancelar</button>
          </div>
        </div>
      )}

      {/* ---- Captura manual ---- */}
      {form && (
        <div className="card p-4 mb-4 space-y-2">
          <input className="ledger-input" placeholder="Descripción del material" value={form.descripcion || ""} onChange={(e) => setForm({ ...form, descripcion: e.target.value })} />
          <select
            className="ledger-input"
            value={form.trabajoId || ""}
            onChange={(e) => {
              const trabajoId = e.target.value;
              const turno = socioTurnoMaterial(data, trabajoId);
              setForm({ ...form, trabajoId, pagadoPor: turno || form.pagadoPor });
            }}
          >
            <option value="">Trabajo…</option>
            {data.trabajos.map((t) => <option key={t.id} value={t.id}>{t.apodo || t.nombre}</option>)}
          </select>
          {form.trabajoId && socioTurnoMaterial(data, form.trabajoId) && (
            <p className="text-[11px] text-[#7A7263]">
              Le toca pagar esta factura a <b>{pagadorNombre(data, socioTurnoMaterial(data, form.trabajoId))}</b> (se alterna con cada factura de este trabajo)
            </p>
          )}
          <input className="ledger-input" type="number" placeholder="Monto" value={form.monto || ""} onChange={(e) => setForm({ ...form, monto: e.target.value })} />
          <input className="ledger-input" type="date" value={form.fecha} onChange={(e) => setForm({ ...form, fecha: e.target.value })} />
          <select className="ledger-input" value={form.pagadoPor || "empresa"} onChange={(e) => setForm({ ...form, pagadoPor: e.target.value })}>
            <option value="empresa">Pagado desde cuenta de {data.empresaNombre}</option>
            <option value="cliente">Lo pagó la empresa que nos contrató (no afecta la ganancia)</option>
            {data.socios.map((s) => <option key={s.id} value={s.id}>Pagado por {s.nombre} (a reembolsar)</option>)}
            <option value="empleado">Lo pagó un trabajador (a reembolsar)</option>
          </select>
          {form.pagadoPor === "empleado" && (
            <select className="ledger-input" value={form.empleadoPagadorId || ""} onChange={(e) => setForm({ ...form, empleadoPagadorId: e.target.value })}>
              <option value="">¿Qué trabajador?</option>
              {data.empleados.map((emp) => <option key={emp.id} value={emp.id}>{emp.nombre}</option>)}
            </select>
          )}
          {form.pagadoPor !== "cliente" && (
            <select className="ledger-input" value={form.cuentaId || ""} onChange={(e) => setForm({ ...form, cuentaId: e.target.value })}>
              <option value="">Cuenta bancaria…</option>
              {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          )}
          <input className="ledger-input" placeholder="Número de cheque (si aplica)" value={form.numeroCheque || ""} onChange={(e) => setForm({ ...form, numeroCheque: e.target.value })} />
          <input className="ledger-input" placeholder="Número de invoice (si el recibo trae uno)" value={form.numeroInvoice || ""} onChange={(e) => setForm({ ...form, numeroInvoice: e.target.value })} />

          <label className="flex items-center gap-2 border border-dashed p-3 cursor-pointer text-sm" style={{ borderColor: LINE }}>
            <Camera size={16} className="text-[#7A7263]" />
            <span className="text-[#4A4238]">
              {uploading ? "Procesando foto…" : (form.fotos?.length ? `${form.fotos.length} foto(s) adjuntada(s) · agregar otra` : "Adjuntar foto(s) de la factura")}
            </span>
            <input type="file" accept="image/*" multiple className="hidden" onChange={handleFoto} />
          </label>
          {form.fotos?.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {form.fotos.map((f, idx) => (
                <div key={idx} className="relative">
                  <img src={f} alt={`Página ${idx + 1}`} className="h-20 w-auto border" style={{ borderColor: LINE }} />
                  <button
                    type="button"
                    onClick={() => quitarFotoForm(idx)}
                    className="absolute -top-1.5 -right-1.5 bg-white border rounded-full"
                    style={{ borderColor: LINE }}
                  >
                    <X size={12} className="text-[#A13D2E]" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-[#7A7263]">Si la factura tiene varias hojas, puedes agregarlas todas — toca "agregar otra" las veces que necesites.</p>

          <div className="flex gap-2">
            <button className="btn-primary" onClick={addMaterial} disabled={uploading}><Check size={14} /> Guardar</button>
            <button className="text-sm text-[#7A7263] px-2" onClick={() => setForm(null)}>Cancelar</button>
          </div>
        </div>
      )}

      <div className="card p-4">
        {data.materiales.length === 0 && <Empty text="Sin materiales registrados." />}
        {gruposPorTrabajo.map((bloque) => (
          <div key={bloque.trabajoId || "sin-trabajo"}>
            <div className="flex items-center gap-2 pt-3 pb-1 first:pt-0">
              <span className="stamp text-[12px] text-[#1E2A38]">
                {bloque.trab ? `${bloque.trab.numeroTrabajo ? `#${bloque.trab.numeroTrabajo} · ` : ""}${bloque.trab.apodo || bloque.trab.nombre}` : "Sin trabajo asignado"}
              </span>
              {bloque.trab?.estado === "cerrado" && (
                <span className="text-[9px] uppercase px-1.5 py-0.5" style={{ background: "#E1EEE6", color: GREEN }}>Concluido</span>
              )}
              <div className="flex-1 h-px" style={{ background: AMBER }} />
            </div>
        {bloque.grupos.map((grupo) => {
          if (!grupo.facturaId) {
            // Material suelto (capturado a mano, sin factura de varios artículos) — se muestra igual que antes
            const m = grupo.items[0];
            const trab = data.trabajos.find((t) => t.id === m.trabajoId);
            const fotosM = m.fotos?.length ? m.fotos : (m.foto ? [m.foto] : []);
            return (
              <div key={m.id} className="flex justify-between items-center py-1.5 text-sm border-b last:border-0" style={{ borderColor: LINE }}>
                <div className="flex items-center gap-2">
                  {fotosM.length > 0 ? (
                    <div className="flex -space-x-2 shrink-0">
                      {fotosM.slice(0, 3).map((f, idx) => (
                        <img key={idx} src={f} alt={`Factura página ${idx + 1}`} className="w-9 h-9 object-cover border cursor-pointer" style={{ borderColor: LINE }} onClick={() => onViewPhoto?.(f)} />
                      ))}
                      {fotosM.length > 3 && (
                        <div className="w-9 h-9 flex items-center justify-center border bg-[#F3EEE4] text-[10px] text-[#7A7263]" style={{ borderColor: LINE }}>+{fotosM.length - 3}</div>
                      )}
                    </div>
                  ) : (
                    <div className="w-9 h-9 flex items-center justify-center border shrink-0 text-[#C9C1B0]" style={{ borderColor: LINE }}><ImageOff size={14} /></div>
                  )}
                  <div>
                    <div>{m.descripcion} <span className="text-[11px] text-[#7A7263]">{trab ? `· ${trab.apodo || trab.nombre}` : ""}</span>{trab?.estado === "cerrado" && (
                      <span className="text-[9px] uppercase px-1.5 py-0.5 ml-1" style={{ background: "#E1EEE6", color: GREEN }}>Concluido</span>
                    )}</div>
                    <div className="text-[11px] text-[#7A7263]">
                      {fmtDate(m.fecha)} · pagado por {pagadorNombre(data, m.pagadoPor)}
                      {m.reembolsado ? " · reembolsado" : ""}
                      {m.pagadoPor === "cliente" ? " · no afecta ganancia" : ""}
                    </div>
                    {m.montoDevuelto > 0 && (
                      <div className="flex items-center gap-1.5 text-[11px]" style={{ color: AMBER }}>
                        {m.fotoDevolucion && (
                          <img src={m.fotoDevolucion} alt="Foto de devolución" className="w-6 h-6 object-cover border cursor-pointer shrink-0" style={{ borderColor: AMBER }} onClick={() => onViewPhoto?.(m.fotoDevolucion)} />
                        )}
                        <span>Devolviste {money(m.montoDevuelto)} de esta compra</span>
                      </div>
                    )}
                    {devolucionId === m.id ? (
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        <span className="text-[11px] text-[#7A7263]">¿Cuánto devolviste?</span>
                        <input
                          className="ledger-input text-xs w-24 py-1"
                          type="number"
                          autoFocus
                          value={devolucionMonto}
                          onChange={(e) => setDevolucionMonto(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              update((d) => { d.materiales.find((x) => x.id === m.id).montoDevuelto = Number(devolucionMonto) || 0; });
                              setDevolucionId(null);
                            }
                          }}
                        />
                        <label className="text-[11px] text-[#7A7263] underline cursor-pointer flex items-center gap-0.5">
                          <Camera size={12} /> {devolucionFotoSubiendo ? "Subiendo…" : (devolucionFoto ? "Foto agregada ✓" : "Agregar foto")}
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              setDevolucionFotoSubiendo(true);
                              try {
                                const dataUrl = await compressImage(file);
                                setDevolucionFoto(await subirFoto(dataUrl));
                              } catch {}
                              setDevolucionFotoSubiendo(false);
                            }}
                          />
                        </label>
                        {ultimaFotoDevolucion && ultimaFotoDevolucion !== devolucionFoto && (
                          <button type="button" className="text-[11px] text-[#7A7263] underline" onClick={() => setDevolucionFoto(ultimaFotoDevolucion)}>
                            usar la misma foto de la última devolución
                          </button>
                        )}
                        <button
                          className="text-[#3B6E52]"
                          onClick={() => {
                            update((d) => {
                              const item = d.materiales.find((x) => x.id === m.id);
                              item.montoDevuelto = Number(devolucionMonto) || 0;
                              if (devolucionFoto) item.fotoDevolucion = devolucionFoto;
                            });
                            if (devolucionFoto) setUltimaFotoDevolucion(devolucionFoto);
                            setDevolucionId(null);
                            setDevolucionFoto(null);
                          }}
                        >
                          <Check size={13} />
                        </button>
                        <button className="text-[#7A7263]" onClick={() => { setDevolucionId(null); setDevolucionFoto(null); }}><X size={13} /></button>
                      </div>
                    ) : (
                      <button className="text-[11px] text-[#7A7263] underline mt-0.5" onClick={() => { setDevolucionId(m.id); setDevolucionMonto(m.montoDevuelto || ""); setDevolucionFoto(m.fotoDevolucion || null); }}>
                        {m.montoDevuelto > 0 ? "Editar devolución" : "¿Devolviste algo?"}
                      </button>
                    )}
                    {editandoMaterialId === m.id ? (
                      <div className="border p-2 mt-1 space-y-1.5" style={{ borderColor: AMBER, background: "#FBF8F2" }}>
                        <select className="ledger-input text-xs" value={editMaterialForm.trabajoId || ""} onChange={(e) => setEditMaterialForm({ ...editMaterialForm, trabajoId: e.target.value })}>
                          <option value="">Trabajo…</option>
                          {data.trabajos.map((t) => <option key={t.id} value={t.id}>{t.apodo || t.nombre}</option>)}
                        </select>
                        <select
                          className="ledger-input text-xs"
                          value={editMaterialForm.pagadoPor?.startsWith("empleado:") ? "empleado" : (editMaterialForm.pagadoPor || "empresa")}
                          onChange={(e) => setEditMaterialForm({ ...editMaterialForm, pagadoPor: e.target.value })}
                        >
                          <option value="empresa">Pagado desde cuenta de {data.empresaNombre}</option>
                          <option value="cliente">Lo pagó la empresa que nos contrató (no afecta la ganancia)</option>
                          {data.socios.map((s) => <option key={s.id} value={s.id}>Pagado por {s.nombre} (a reembolsar)</option>)}
                          <option value="empleado">Lo pagó un trabajador (a reembolsar)</option>
                        </select>
                        {editMaterialForm.pagadoPor === "empleado" && (
                          <select className="ledger-input text-xs" value={editMaterialForm.empleadoPagadorId || ""} onChange={(e) => setEditMaterialForm({ ...editMaterialForm, empleadoPagadorId: e.target.value })}>
                            <option value="">¿Qué trabajador?</option>
                            {data.empleados.map((emp) => <option key={emp.id} value={emp.id}>{emp.nombre}</option>)}
                          </select>
                        )}
                        <select className="ledger-input text-xs" value={editMaterialForm.cuentaId || ""} onChange={(e) => setEditMaterialForm({ ...editMaterialForm, cuentaId: e.target.value })}>
                          <option value="">Cuenta bancaria…</option>
                          {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                        </select>
                        <input className="ledger-input text-xs" placeholder="Número de cheque (si aplica)" value={editMaterialForm.numeroCheque || ""} onChange={(e) => setEditMaterialForm({ ...editMaterialForm, numeroCheque: e.target.value })} />
                        <input className="ledger-input text-xs" placeholder="Número de invoice" value={editMaterialForm.numeroInvoice || ""} onChange={(e) => setEditMaterialForm({ ...editMaterialForm, numeroInvoice: e.target.value })} />
                        <div className="flex gap-2">
                          <button
                            className="btn-primary text-xs"
                            onClick={() => {
                              update((d) => {
                                const item = d.materiales.find((x) => x.id === m.id);
                                item.trabajoId = editMaterialForm.trabajoId || "";
                                item.pagadoPor = editMaterialForm.pagadoPor === "empleado" ? `empleado:${editMaterialForm.empleadoPagadorId}` : (editMaterialForm.pagadoPor || "empresa");
                                item.cuentaId = editMaterialForm.cuentaId || "";
                                item.numeroCheque = editMaterialForm.numeroCheque || "";
                                item.numeroInvoice = editMaterialForm.numeroInvoice || "";
                              });
                              setEditandoMaterialId(null);
                            }}
                          >
                            <Check size={12} /> Guardar
                          </button>
                          <button className="text-xs text-[#7A7263] px-2" onClick={() => setEditandoMaterialId(null)}>Cancelar</button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="text-[11px] text-[#7A7263] underline mt-0.5 ml-2"
                        onClick={() => {
                          const esEmpleado = (m.pagadoPor || "").startsWith("empleado:");
                          setEditMaterialForm({ trabajoId: m.trabajoId || "", pagadoPor: esEmpleado ? "empleado" : (m.pagadoPor || "empresa"), empleadoPagadorId: esEmpleado ? m.pagadoPor.slice("empleado:".length) : "", cuentaId: m.cuentaId || "", numeroCheque: m.numeroCheque || "", numeroInvoice: m.numeroInvoice || "" });
                          setEditandoMaterialId(m.id);
                        }}
                      >
                        Editar
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="mono">{money(materialNeto(m))}</span>
                  <button className="text-[#A13D2E]" title="Eliminar material" onClick={() => update((d) => { d.materiales = d.materiales.filter((x) => x.id !== m.id); })}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          }

          // Factura con varios artículos (viene de un escaneo) — se muestra agrupada con un solo resumen y una sola devolución
          const items = grupo.items;
          const fotosFactura = items.map((it) => it.fotos?.length ? it.fotos : []).find((f) => f?.length) || [];
          const trab = data.trabajos.find((t) => t.id === items[0].trabajoId);
          const subtotalOriginal = items.reduce((s, it) => s + Number(it.monto || 0), 0);
          const totalDevuelto = items.reduce((s, it) => s + Number(it.montoDevuelto || 0), 0);
          const totalNeto = subtotalOriginal - totalDevuelto;
          // El impuesto se recalcula en proporción a lo devuelto: si devolviste la mitad de la factura, se descuenta la mitad del impuesto.
          const impuestoOriginal = Number(items[0]?.impuestoFactura || 0);
          const impuestoDevuelto = totalDevuelto > 0 && subtotalOriginal > 0 ? impuestoOriginal * (totalDevuelto / subtotalOriginal) : 0;
          const impuestoNeto = impuestoOriginal - impuestoDevuelto;
          const fotoDevolucionFactura = items.find((it) => it.fotoDevolucion)?.fotoDevolucion;
          const editandoDevolucionFactura = devolucionId === "factura:" + grupo.facturaId;

          return (
            <div key={grupo.facturaId} className="py-2 border-b last:border-0" style={{ borderColor: LINE }}>
              <div className="flex items-center gap-2 mb-1.5">
                {fotosFactura.length > 0 ? (
                  <div className="flex -space-x-2 shrink-0">
                    {fotosFactura.slice(0, 3).map((f, idx) => (
                      <img key={idx} src={f} alt={`Factura página ${idx + 1}`} className="w-9 h-9 object-cover border cursor-pointer" style={{ borderColor: LINE }} onClick={() => onViewPhoto?.(f)} />
                    ))}
                  </div>
                ) : (
                  <div className="w-9 h-9 flex items-center justify-center border shrink-0 text-[#C9C1B0]" style={{ borderColor: LINE }}><ImageOff size={14} /></div>
                )}
                <div className="text-[12px] text-[#7A7263] flex items-center gap-1 flex-wrap">
                  <span>Factura · {items.length} artículos · {fmtDate(items[0].fecha)} {trab ? `· ${trab.apodo || trab.nombre}` : ""} · pagado por {pagadorNombre(data, items[0].pagadoPor)}</span>
                  {trab?.estado === "cerrado" && (
                    <span className="text-[9px] uppercase px-1.5 py-0.5" style={{ background: "#E1EEE6", color: GREEN }}>Concluido</span>
                  )}
                </div>
              </div>

              <div className="pl-2 space-y-1 mb-2">
                {items.map((it) => {
                  const noCoincide = it.trabajoId !== items[0].trabajoId;
                  return (
                    <div key={it.id}>
                      <div className="flex justify-between items-center text-[13px]">
                        <span className="flex-1">{it.descripcion}</span>
                        <span className="mono text-[#7A7263] mr-2">{money(Number(it.monto))}</span>
                        <button
                          className="text-[11px] text-[#7A7263] underline mr-2 shrink-0"
                          onClick={() => {
                            const esEmpleado = (it.pagadoPor || "").startsWith("empleado:");
                            setEditMaterialForm({ trabajoId: it.trabajoId || "", pagadoPor: esEmpleado ? "empleado" : (it.pagadoPor || "empresa"), empleadoPagadorId: esEmpleado ? it.pagadoPor.slice("empleado:".length) : "", cuentaId: it.cuentaId || "", numeroCheque: it.numeroCheque || "", numeroInvoice: it.numeroInvoice || "" });
                            setEditandoMaterialId(it.id);
                          }}
                        >
                          Editar
                        </button>
                        <button
                          className="text-[#A13D2E] shrink-0"
                          title="Eliminar este artículo"
                          onClick={() => update((d) => { d.materiales = d.materiales.filter((x) => x.id !== it.id); })}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      {noCoincide && (
                        <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "#A13D2E" }}>
                          <span>⚠ Este artículo está asignado a otro trabajo ({data.trabajos.find((t) => t.id === it.trabajoId)?.apodo || data.trabajos.find((t) => t.id === it.trabajoId)?.nombre || "ninguno"}) — por eso no aparece en el reporte de "{trab?.apodo || trab?.nombre}".</span>
                          <button
                            className="underline shrink-0"
                            onClick={() => update((d) => { d.materiales.find((x) => x.id === it.id).trabajoId = items[0].trabajoId; })}
                          >
                            Corregir
                          </button>
                        </div>
                      )}
                      {editandoMaterialId === it.id && (
                        <div className="border p-2 mt-1 mb-1 space-y-1.5" style={{ borderColor: AMBER, background: "#FBF8F2" }}>
                          <select className="ledger-input text-xs" value={editMaterialForm.trabajoId || ""} onChange={(e) => setEditMaterialForm({ ...editMaterialForm, trabajoId: e.target.value })}>
                            <option value="">Trabajo…</option>
                            {data.trabajos.map((t) => <option key={t.id} value={t.id}>{t.apodo || t.nombre}</option>)}
                          </select>
                          <select
                            className="ledger-input text-xs"
                            value={editMaterialForm.pagadoPor?.startsWith("empleado:") ? "empleado" : (editMaterialForm.pagadoPor || "empresa")}
                            onChange={(e) => setEditMaterialForm({ ...editMaterialForm, pagadoPor: e.target.value })}
                          >
                            <option value="empresa">Pagado desde cuenta de {data.empresaNombre}</option>
                            <option value="cliente">Lo pagó la empresa que nos contrató (no afecta la ganancia)</option>
                            {data.socios.map((s) => <option key={s.id} value={s.id}>Pagado por {s.nombre} (a reembolsar)</option>)}
                            <option value="empleado">Lo pagó un trabajador (a reembolsar)</option>
                          </select>
                          {editMaterialForm.pagadoPor === "empleado" && (
                            <select className="ledger-input text-xs" value={editMaterialForm.empleadoPagadorId || ""} onChange={(e) => setEditMaterialForm({ ...editMaterialForm, empleadoPagadorId: e.target.value })}>
                              <option value="">¿Qué trabajador?</option>
                              {data.empleados.map((emp) => <option key={emp.id} value={emp.id}>{emp.nombre}</option>)}
                            </select>
                          )}
                          <select className="ledger-input text-xs" value={editMaterialForm.cuentaId || ""} onChange={(e) => setEditMaterialForm({ ...editMaterialForm, cuentaId: e.target.value })}>
                            <option value="">Cuenta bancaria…</option>
                            {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                          </select>
                          <input className="ledger-input text-xs" placeholder="Número de cheque (si aplica)" value={editMaterialForm.numeroCheque || ""} onChange={(e) => setEditMaterialForm({ ...editMaterialForm, numeroCheque: e.target.value })} />
                          <input className="ledger-input text-xs" placeholder="Número de invoice" value={editMaterialForm.numeroInvoice || ""} onChange={(e) => setEditMaterialForm({ ...editMaterialForm, numeroInvoice: e.target.value })} />
                          <div className="flex gap-2">
                            <button
                              className="btn-primary text-xs"
                              onClick={() => {
                                update((d) => {
                                  const item = d.materiales.find((x) => x.id === it.id);
                                  item.trabajoId = editMaterialForm.trabajoId || "";
                                  item.pagadoPor = editMaterialForm.pagadoPor === "empleado" ? `empleado:${editMaterialForm.empleadoPagadorId}` : (editMaterialForm.pagadoPor || "empresa");
                                  item.cuentaId = editMaterialForm.cuentaId || "";
                                  item.numeroCheque = editMaterialForm.numeroCheque || "";
                                  item.numeroInvoice = editMaterialForm.numeroInvoice || "";
                                });
                                setEditandoMaterialId(null);
                              }}
                            >
                              <Check size={12} /> Guardar
                            </button>
                            <button className="text-xs text-[#7A7263] px-2" onClick={() => setEditandoMaterialId(null)}>Cancelar</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {totalDevuelto > 0 && (
                <div className="flex items-center gap-1.5 text-[11px] pl-2 mb-1" style={{ color: AMBER }}>
                  {fotoDevolucionFactura && (
                    <img src={fotoDevolucionFactura} alt="Foto de devolución" className="w-6 h-6 object-cover border cursor-pointer shrink-0" style={{ borderColor: AMBER }} onClick={() => onViewPhoto?.(fotoDevolucionFactura)} />
                  )}
                  <span>Devolviste {money(totalDevuelto)} de esta factura</span>
                </div>
              )}

              {editandoDevolucionFactura ? (
                <div className="pl-2 mb-1 space-y-1.5">
                  <div className="text-[11px] text-[#7A7263]">¿Cuáles artículos devolviste? (marca los que aplique, puedes ajustar el monto si fue parcial)</div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <label className="text-[11px] underline cursor-pointer flex items-center gap-0.5" style={{ color: AMBER }}>
                      <Camera size={12} /> {devolucionEscaneando ? "Leyendo recibo…" : "Escanear recibo de devolución (IA)"}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          setDevolucionEscaneando(true);
                          setDevolucionEscaneoError("");
                          try {
                            const dataUrl = await compressImage(file);
                            const parsed = await extraerFacturaConIA(dataUrl);
                            // Empareja lo leído por la IA con los artículos de esta factura, por nombre parecido.
                            const seleccionInicial = {};
                            (parsed.items || []).forEach((li) => {
                              const nombreLeido = (li.descripcion || "").toLowerCase().trim();
                              const match = items.find((it) => {
                                const nombreOrig = (it.descripcion || "").toLowerCase().trim();
                                return nombreOrig && (nombreOrig.includes(nombreLeido) || nombreLeido.includes(nombreOrig));
                              });
                              if (match) seleccionInicial[match.id] = Number(li.monto) || 0;
                            });
                            setDevolucionSeleccion(seleccionInicial);
                            setDevolucionImpuesto(parsed.impuesto ?? "");
                            setDevolucionFoto(await subirFoto(dataUrl));
                          } catch (err) {
                            setDevolucionEscaneoError("No pude leer el recibo, intenta de nuevo o llénalo a mano.");
                          }
                          setDevolucionEscaneando(false);
                        }}
                      />
                    </label>
                  </div>
                  {devolucionEscaneoError && <div className="text-[11px] text-red-600">{devolucionEscaneoError}</div>}
                  {items.map((it) => {
                    const marcado = devolucionSeleccion[it.id] !== undefined;
                    return (
                      <div key={it.id} className="flex items-center gap-2 text-[12px]">
                        <input
                          type="checkbox"
                          checked={marcado}
                          onChange={(e) => {
                            setDevolucionSeleccion((sel) => {
                              const nuevo = { ...sel };
                              if (e.target.checked) nuevo[it.id] = Number(it.monto) || 0;
                              else delete nuevo[it.id];
                              return nuevo;
                            });
                          }}
                        />
                        <span className="flex-1">{it.descripcion}</span>
                        {marcado ? (
                          <input
                            className="ledger-input text-xs w-20 py-0.5"
                            type="number"
                            value={devolucionSeleccion[it.id]}
                            onChange={(e) => setDevolucionSeleccion((sel) => ({ ...sel, [it.id]: e.target.value }))}
                          />
                        ) : (
                          <span className="text-[#7A7263]">{money(Number(it.monto))}</span>
                        )}
                      </div>
                    );
                  })}
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="text-[11px] text-[#7A7263]">Impuesto devuelto (según el recibo de la devolución):</span>
                    <input
                      className="ledger-input text-xs w-20 py-0.5"
                      type="number"
                      placeholder="0.00"
                      value={devolucionImpuesto}
                      onChange={(e) => setDevolucionImpuesto(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1">
                    <label className="text-[11px] text-[#7A7263] underline cursor-pointer flex items-center gap-0.5">
                      <Camera size={12} /> {devolucionFotoSubiendo ? "Subiendo…" : (devolucionFoto ? "Foto agregada ✓" : "Agregar foto")}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          setDevolucionFotoSubiendo(true);
                          try {
                            const dataUrl = await compressImage(file);
                            setDevolucionFoto(await subirFoto(dataUrl));
                          } catch {}
                          setDevolucionFotoSubiendo(false);
                        }}
                      />
                    </label>
                    {ultimaFotoDevolucion && ultimaFotoDevolucion !== devolucionFoto && (
                      <button type="button" className="text-[11px] text-[#7A7263] underline" onClick={() => setDevolucionFoto(ultimaFotoDevolucion)}>
                        usar la misma foto de la última devolución
                      </button>
                    )}
                  </div>
                  <div className="flex gap-2 mt-2">
                    <button
                      className="btn-primary"
                      onClick={() => {
                        update((d) => {
                          let primeraConFoto = false;
                          items.forEach((it, idx) => {
                            const item = d.materiales.find((x) => x.id === it.id);
                            const monto = devolucionSeleccion[it.id] !== undefined ? Number(devolucionSeleccion[it.id]) || 0 : 0;
                            item.montoDevuelto = monto;
                            if (devolucionFoto && !primeraConFoto && monto > 0) {
                              item.fotoDevolucion = devolucionFoto;
                              primeraConFoto = true;
                            } else if (monto === 0) {
                              item.fotoDevolucion = "";
                            }
                            if (idx === 0) item.impuestoDevuelto = Number(devolucionImpuesto) || 0;
                          });
                        });
                        if (devolucionFoto) setUltimaFotoDevolucion(devolucionFoto);
                        setDevolucionId(null);
                        setDevolucionFoto(null);
                        setDevolucionSeleccion({});
                        setDevolucionImpuesto("");
                      }}
                    >
                      <Check size={14} /> Guardar devolución
                    </button>
                    <button className="text-sm text-[#7A7263] px-2" onClick={() => { setDevolucionId(null); setDevolucionFoto(null); setDevolucionSeleccion({}); setDevolucionImpuesto(""); }}>Cancelar</button>
                  </div>
                </div>
              ) : (
                <button
                  className="text-[11px] text-[#7A7263] underline pl-2"
                  onClick={() => {
                    setDevolucionId("factura:" + grupo.facturaId);
                    setDevolucionFoto(fotoDevolucionFactura || null);
                    const seleccionInicial = {};
                    items.forEach((it) => { if (Number(it.montoDevuelto) > 0) seleccionInicial[it.id] = it.montoDevuelto; });
                    setDevolucionSeleccion(seleccionInicial);
                    setDevolucionImpuesto(items[0]?.impuestoDevuelto || "");
                  }}
                >
                  {totalDevuelto > 0 ? "Editar devolución de esta factura" : "¿Devolviste algún artículo de esta factura?"}
                </button>
              )}

              <div className="flex justify-between items-center pl-2 mt-1.5">
                <div className="text-[12px]">
                  <span className="text-[#7A7263]">Subtotal factura: {money(subtotalOriginal)}</span>
                  {totalDevuelto > 0 && <span className="text-[#7A7263]"> · Devuelto: {money(totalDevuelto)}</span>}
                  {impuestoOriginal > 0 && (
                    <span className="text-[#7A7263]">
                      {" "}· Impuesto: {money(impuestoNeto)}
                      {impuestoDevuelto > 0 && <span> (se descontó {money(impuestoDevuelto)} por la devolución)</span>}
                    </span>
                  )}
                  {items[0]?.numeroCheque && <span className="text-[#7A7263]"> · Cheque #{items[0].numeroCheque}</span>}
                  {items[0]?.numeroInvoice && <span className="text-[#7A7263]"> · Invoice #{items[0].numeroInvoice}</span>}
                </div>
                <span className="mono font-medium">{money(totalNeto)}</span>
              </div>
            </div>
          );
        })}
          </div>
        ))}
      </div>

      {mostrarGaleria && (
        <GaleriaFacturasModal gruposPorTrabajo={gruposPorTrabajo} onViewPhoto={onViewPhoto} onClose={() => setMostrarGaleria(false)} />
      )}
    </div>
  );
}

// Modal tipo "carpetas" con todas las fotos de facturas de materiales, agrupadas por número de trabajo —
// para tenerlas todas juntas como archivo, sin tener que buscarlas una por una en la lista.
function GaleriaFacturasModal({ gruposPorTrabajo, onViewPhoto, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-40 p-4" onClick={onClose}>
      <div className="bg-white max-w-2xl w-full max-h-[85vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <span className="stamp text-[14px]">Fotos de facturas por trabajo</span>
          <button onClick={onClose}><X size={20} /></button>
        </div>
        {gruposPorTrabajo.length === 0 && <Empty text="Sin fotos de facturas todavía." />}
        {gruposPorTrabajo.map((bloque) => {
          const fotosCompra = [];
          const fotosDevolucion = [];
          bloque.grupos.forEach((g) => {
            g.items.forEach((it) => {
              (it.fotos?.length ? it.fotos : (it.foto ? [it.foto] : [])).forEach((f) => fotosCompra.push(f));
              if (it.fotoDevolucion) fotosDevolucion.push(it.fotoDevolucion);
            });
          });
          if (fotosCompra.length === 0 && fotosDevolucion.length === 0) return null;
          return (
            <div key={bloque.trabajoId || "sin-trabajo"} className="mb-4">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[12px] font-medium">
                  {bloque.trab ? `${bloque.trab.numeroTrabajo ? `#${bloque.trab.numeroTrabajo} · ` : ""}${bloque.trab.apodo || bloque.trab.nombre}` : "Sin trabajo asignado"}
                </span>
                {bloque.trab?.estado === "cerrado" && (
                  <span className="text-[9px] uppercase px-1.5 py-0.5" style={{ background: "#E1EEE6", color: GREEN }}>Concluido</span>
                )}
              </div>
              {fotosCompra.length > 0 && (
                <div className="mb-2">
                  <div className="text-[10px] uppercase text-[#7A7263] mb-1">Facturas de compra</div>
                  <div className="flex flex-wrap gap-1.5">
                    {fotosCompra.map((f, idx) => (
                      <img
                        key={idx}
                        src={f}
                        alt={`Factura ${idx + 1}`}
                        className="w-16 h-16 object-cover border cursor-pointer"
                        style={{ borderColor: LINE }}
                        onClick={() => onViewPhoto?.(f)}
                      />
                    ))}
                  </div>
                </div>
              )}
              {fotosDevolucion.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase mb-1" style={{ color: AMBER }}>Devoluciones</div>
                  <div className="flex flex-wrap gap-1.5">
                    {fotosDevolucion.map((f, idx) => (
                      <img
                        key={idx}
                        src={f}
                        alt={`Devolución ${idx + 1}`}
                        className="w-16 h-16 object-cover border cursor-pointer"
                        style={{ borderColor: AMBER }}
                        onClick={() => onViewPhoto?.(f)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Cuentas ---------------- */
function Cuentas({ data, update, onViewPhoto }) {
  const [form, setForm] = useState(null);
  const [transferForm, setTransferForm] = useState(null);
  const [incomeForm, setIncomeForm] = useState(null);
  const [cuentaModal, setCuentaModal] = useState(null);
  const [editandoIngresoId, setEditandoIngresoId] = useState(null);
  const [cuentaEditTemp, setCuentaEditTemp] = useState("");
  const [editandoTransferId, setEditandoTransferId] = useState(null);
  const [transferEditTemp, setTransferEditTemp] = useState({ deCuentaId: "", aCuentaId: "" });

  const addCuenta = () => {
    if (!form?.nombre) return;
    update((d) => d.cuentas.push({ id: uid(), nombre: form.nombre, banco: form.banco || "", saldoInicial: Number(form.saldoInicial || 0), esPersonal: !!form.esPersonal }));
    setForm(null);
  };

  const addIngreso = () => {
    if (!incomeForm?.cuentaId || !incomeForm?.monto) return;
    update((d) =>
      d.ingresos.push({
        id: uid(),
        cuentaId: incomeForm.cuentaId,
        trabajoId: incomeForm.trabajoId || "",
        monto: Number(incomeForm.monto),
        fecha: incomeForm.fecha || todayISO(),
        concepto: incomeForm.concepto || "Pago de cliente",
        formaPago: incomeForm.formaPago || "efectivo",
        numeroCheque: incomeForm.formaPago === "cheque" ? (incomeForm.numeroCheque || "") : "",
        antesSociedad: !!incomeForm.antesSociedad,
        numeroInvoice: incomeForm.numeroInvoice || "",
        fechaFacturaEnviada: incomeForm.fechaFacturaEnviada || "",
        fotosInvoice: incomeForm.fotosInvoice || [],
        estado: incomeForm.estado === "pendiente" ? "pendiente" : "cobrado",
        fechaEsperada: incomeForm.estado === "pendiente" ? (incomeForm.fechaEsperada || "") : "",
      })
    );
    setIncomeForm(null);
  };

  const addTransfer = () => {
    if (!transferForm?.deCuentaId || !transferForm?.aCuentaId || !transferForm?.monto) return;
    update((d) =>
      d.transferencias.push({
        id: uid(),
        deCuentaId: transferForm.deCuentaId,
        aCuentaId: transferForm.aCuentaId,
        monto: Number(transferForm.monto),
        fecha: transferForm.fecha || todayISO(),
        formaPago: transferForm.formaPago || "efectivo",
        numeroCheque: transferForm.formaPago === "cheque" ? (transferForm.numeroCheque || "") : "",
        antesSociedad: !!transferForm.antesSociedad,
      })
    );
    setTransferForm(null);
  };

  const formaPagoTexto = (fp, numCheque) => {
    const base = fp === "cheque" ? "Cheque" : fp === "zelle" ? "Zelle" : "Efectivo";
    return fp === "cheque" && numCheque ? `${base} #${numCheque}` : base;
  };

  return (
    <div>
      <SectionTitle sub="Saldo calculado automáticamente por cuenta, según ingresos, gastos y transferencias">Cuentas bancarias</SectionTitle>

      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        {data.cuentas.map((c) => {
          const saldo = calcCuentaSaldo(c, data);
          return (
            <div key={c.id} className="card p-4">
              <div className="flex justify-between items-start">
                <div>
                  <div className="font-medium text-sm">
                    {c.nombre}
                    {c.esPersonal && (
                      <span className="ml-1.5 text-[9px] uppercase px-1.5 py-0.5" style={{ background: "#FBE9D9", color: AMBER }}>Personal</span>
                    )}
                  </div>
                  <div className="text-[11px] text-[#7A7263]">{c.banco}</div>
                  <button
                    className="text-[10px] underline mt-0.5"
                    style={{ color: "#7A7263" }}
                    onClick={() => update((d) => { const cuenta = d.cuentas.find((x) => x.id === c.id); cuenta.esPersonal = !cuenta.esPersonal; })}
                  >
                    Marcar como {c.esPersonal ? "cuenta de la empresa" : "cuenta personal"}
                  </button>
                </div>
                <button className="text-[#A13D2E]" onClick={() => update((d) => { d.cuentas = d.cuentas.filter((x) => x.id !== c.id); })}>
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="mono text-lg font-semibold mt-2" style={{ color: saldo >= 0 ? GREEN : RED }}>{money(saldo)}</div>
              <div className="text-[10px] uppercase tracking-widest text-[#7A7263]">saldo actual</div>
              <button
                className="text-[11px] text-[#7A7263] underline flex items-center gap-1 mt-2"
                onClick={() => setCuentaModal(c)}
              >
                <Printer size={12} /> Imprimir/descargar movimientos
              </button>
            </div>
          );
        })}
        {data.cuentas.length === 0 && <Empty text="Sin cuentas registradas." />}
      </div>

      {!form ? (
        <button className="btn-primary mb-6" onClick={() => setForm({})}><Plus size={14} /> Cuenta bancaria</button>
      ) : (
        <div className="card p-4 mb-6 space-y-2">
          <input className="ledger-input" placeholder="Nombre de la cuenta (ej. Cuenta operativa)" value={form.nombre || ""} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
          <input className="ledger-input" placeholder="Banco" value={form.banco || ""} onChange={(e) => setForm({ ...form, banco: e.target.value })} />
          <input className="ledger-input" type="number" placeholder="Saldo inicial" value={form.saldoInicial || ""} onChange={(e) => setForm({ ...form, saldoInicial: e.target.value })} />
          <label className="flex items-center gap-1.5 text-[12px] text-[#7A7263] cursor-pointer">
            <input type="checkbox" checked={!!form.esPersonal} onChange={(e) => setForm({ ...form, esPersonal: e.target.checked })} />
            Es cuenta personal (ej. CashApp de un socio, no de la empresa)
          </label>
          <div className="flex gap-2">
            <button className="btn-primary" onClick={addCuenta}><Check size={14} /> Guardar</button>
            <button className="text-sm text-[#7A7263] px-2" onClick={() => setForm(null)}>Cancelar</button>
          </div>
        </div>
      )}

      {(() => {
        const entrado = data.ingresos.filter((i) => i.antesSociedad).reduce((s, i) => s + Number(i.monto || 0), 0);
        const gastado =
          data.nomina.filter((n) => n.antesSociedad).reduce((s, n) => s + Number(n.monto || 0), 0) +
          data.transferencias.filter((t) => t.antesSociedad).reduce((s, t) => s + Number(t.monto || 0), 0);
        if (entrado === 0 && gastado === 0) return null;
        const disponible = entrado - gastado;
        return (
          <div className="card p-4 mb-4" style={{ borderColor: AMBER }}>
            <div className="stamp text-[12px] mb-3" style={{ color: AMBER }}>DINERO DE ANTES DE LA SOCIEDAD</div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <div className="text-[10px] text-[#7A7263] uppercase mb-0.5">Entrado</div>
                <div className="mono font-medium text-[14px]">{money(entrado)}</div>
              </div>
              <div>
                <div className="text-[10px] text-[#7A7263] uppercase mb-0.5">Gastado</div>
                <div className="mono font-medium text-[14px]">{money(gastado)}</div>
              </div>
              <div>
                <div className="text-[10px] text-[#7A7263] uppercase mb-0.5">Disponible</div>
                <div className="mono font-medium text-[14px]" style={{ color: disponible >= 0 ? GREEN : RED }}>{money(disponible)}</div>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="card p-4">
          <div className="stamp text-[13px] text-[#7A7263] mb-3">INGRESO DE CLIENTE</div>
          {!incomeForm ? (
            <button className="btn-primary" onClick={() => setIncomeForm({ fecha: todayISO(), formaPago: "efectivo" })} disabled={data.cuentas.length === 0}><Plus size={14} /> Ingreso</button>
          ) : (
            <div className="space-y-2">
              <select className="ledger-input" value={incomeForm.cuentaId || ""} onChange={(e) => setIncomeForm({ ...incomeForm, cuentaId: e.target.value })}>
                <option value="">Cuenta destino…</option>
                {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
              <select className="ledger-input" value={incomeForm.trabajoId || ""} onChange={(e) => setIncomeForm({ ...incomeForm, trabajoId: e.target.value })}>
                <option value="">Trabajo relacionado (opcional)…</option>
                {data.trabajos.map((t) => <option key={t.id} value={t.id}>{t.apodo || t.nombre}</option>)}
              </select>
              <input className="ledger-input" type="number" placeholder="Monto" value={incomeForm.monto || ""} onChange={(e) => setIncomeForm({ ...incomeForm, monto: e.target.value })} />
              <label className="text-[11px] text-[#7A7263] block mb-0.5">{incomeForm.estado === "pendiente" ? "Fecha en que se registró" : "Fecha en que se recibió"}</label>
              <input className="ledger-input" type="date" value={incomeForm.fecha} onChange={(e) => setIncomeForm({ ...incomeForm, fecha: e.target.value })} />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="text-[11px] px-2.5 py-1.5 border flex-1"
                  style={{
                    borderColor: GREEN,
                    background: (incomeForm.estado || "cobrado") === "cobrado" ? GREEN : "#fff",
                    color: (incomeForm.estado || "cobrado") === "cobrado" ? "#fff" : GREEN,
                  }}
                  onClick={() => setIncomeForm({ ...incomeForm, estado: "cobrado" })}
                >
                  Ya se cobró
                </button>
                <button
                  type="button"
                  className="text-[11px] px-2.5 py-1.5 border flex-1"
                  style={{
                    borderColor: AMBER,
                    background: incomeForm.estado === "pendiente" ? AMBER : "#fff",
                    color: incomeForm.estado === "pendiente" ? "#fff" : AMBER,
                  }}
                  onClick={() => setIncomeForm({ ...incomeForm, estado: "pendiente" })}
                >
                  Pendiente de cobro
                </button>
              </div>
              {incomeForm.estado === "pendiente" && (
                <div>
                  <label className="text-[11px] text-[#7A7263] block mb-0.5">Fecha esperada de cobro (opcional)</label>
                  <input className="ledger-input" type="date" value={incomeForm.fechaEsperada || ""} onChange={(e) => setIncomeForm({ ...incomeForm, fechaEsperada: e.target.value })} />
                </div>
              )}
              <select className="ledger-input" value={incomeForm.formaPago || "efectivo"} onChange={(e) => setIncomeForm({ ...incomeForm, formaPago: e.target.value })}>
                <option value="efectivo">Efectivo</option>
                <option value="cheque">Cheque</option>
                <option value="zelle">Zelle</option>
              </select>
              {incomeForm.formaPago === "cheque" && (
                <input className="ledger-input" placeholder="Número de cheque" value={incomeForm.numeroCheque || ""} onChange={(e) => setIncomeForm({ ...incomeForm, numeroCheque: e.target.value })} />
              )}
              <input className="ledger-input" placeholder="Concepto (ej. trabajo, cliente...)" value={incomeForm.concepto || ""} onChange={(e) => setIncomeForm({ ...incomeForm, concepto: e.target.value })} />
              <input className="ledger-input" placeholder="Número de invoice (si aplica)" value={incomeForm.numeroInvoice || ""} onChange={(e) => setIncomeForm({ ...incomeForm, numeroInvoice: e.target.value })} />
              <div>
                <label className="text-[11px] text-[#7A7263] block mb-0.5">Fecha en que se envió la factura/invoice</label>
                <input className="ledger-input" type="date" value={incomeForm.fechaFacturaEnviada || ""} onChange={(e) => setIncomeForm({ ...incomeForm, fechaFacturaEnviada: e.target.value })} />
              </div>
              <FotosAntesDespues
                titulo="Fotos del invoice"
                fotos={incomeForm.fotosInvoice || []}
                onAdd={(url) => setIncomeForm((f) => ({ ...f, fotosInvoice: [...(f.fotosInvoice || []), url] }))}
                onRemove={(idx) => setIncomeForm((f) => ({ ...f, fotosInvoice: (f.fotosInvoice || []).filter((_, i) => i !== idx) }))}
                onViewPhoto={onViewPhoto}
              />
              <label className="flex items-center gap-1.5 text-[12px] text-[#7A7263] cursor-pointer">
                <input type="checkbox" checked={!!incomeForm.antesSociedad} onChange={(e) => setIncomeForm({ ...incomeForm, antesSociedad: e.target.checked })} />
                Es dinero de antes de la sociedad (no mezclar con lo normal)
              </label>
              <div className="flex gap-2">
                <button className="btn-primary" onClick={addIngreso}><Check size={14} /> Guardar</button>
                <button className="text-sm text-[#7A7263] px-2" onClick={() => setIncomeForm(null)}>Cancelar</button>
              </div>
            </div>
          )}
          {data.ingresos.length > 0 && (
            <div className="mt-3 pt-3 space-y-1" style={{ borderTop: `1px dashed ${LINE}` }}>
              {[...data.ingresos].sort((a, b) => (a.fecha < b.fecha ? 1 : -1)).map((ing) => {
                const cuenta = data.cuentas.find((c) => c.id === ing.cuentaId);
                if (editandoIngresoId === ing.id) {
                  return (
                    <div key={ing.id} className="flex items-center gap-1.5 text-[11px] py-1" style={{ borderBottom: `1px dashed ${LINE}` }}>
                      <span className="text-[#7A7263] shrink-0">{money(ing.monto)} · {fmtDate(ing.fecha)} → cuenta:</span>
                      <select
                        className="ledger-input text-xs flex-1"
                        value={cuentaEditTemp}
                        onChange={(e) => setCuentaEditTemp(e.target.value)}
                      >
                        {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                      </select>
                      <button
                        className="text-[11px] px-2 py-1 border shrink-0"
                        style={{ borderColor: GREEN, color: GREEN }}
                        onClick={() => {
                          update((d) => {
                            const item = d.ingresos.find((x) => x.id === ing.id);
                            if (item) item.cuentaId = cuentaEditTemp;
                          });
                          setEditandoIngresoId(null);
                        }}
                      >
                        <Check size={12} />
                      </button>
                      <button className="text-[11px] text-[#7A7263] px-1 shrink-0" onClick={() => setEditandoIngresoId(null)}>Cancelar</button>
                    </div>
                  );
                }
                return (
                  <div key={ing.id} className="py-1.5" style={{ borderBottom: `1px dashed ${LINE}` }}>
                    <div className="flex justify-between items-start gap-2">
                      <div className="text-[12px]">
                        <div className="font-medium">
                          {fmtDate(ing.fecha)} · {cuenta?.nombre || "—"}
                          {ing.antesSociedad && (
                            <span className="ml-1.5 text-[9px] uppercase px-1.5 py-0.5" style={{ background: "#FBE9D9", color: AMBER }}>Antes de la sociedad</span>
                          )}
                          {ing.estado === "pendiente" && (
                            <button
                              className="ml-1.5 text-[9px] uppercase px-1.5 py-0.5"
                              style={{ background: "#FBE9D9", color: AMBER }}
                              title="Tocar para marcar como ya cobrado"
                              onClick={() => update((d) => { const item = d.ingresos.find((x) => x.id === ing.id); if (item) item.estado = "cobrado"; })}
                            >
                              Pendiente de cobro · tocar cuando se cobre
                            </button>
                          )}
                        </div>
                        <div className="text-[11px] text-[#7A7263]">
                          {formaPagoTexto(ing.formaPago, ing.numeroCheque)}
                          {ing.concepto ? ` · ${ing.concepto}` : ""}
                          {ing.numeroInvoice ? ` · Invoice #${ing.numeroInvoice}` : ""}
                          {ing.fechaFacturaEnviada ? ` · Invoice enviado: ${fmtDate(ing.fechaFacturaEnviada)}` : ""}
                        </div>
                        {(ing.fotosInvoice?.length > 0) && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {ing.fotosInvoice.map((f, idx) => (
                              <img
                                key={idx}
                                src={f}
                                alt={`Invoice ${idx + 1}`}
                                className="w-10 h-10 object-cover border cursor-pointer"
                                style={{ borderColor: LINE }}
                                onClick={() => onViewPhoto?.(f)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="mono font-medium" style={{ color: GREEN }}>{money(ing.monto)}</span>
                        <button
                          className="text-[#7A7263]"
                          title="Cambiar la cuenta de este ingreso"
                          onClick={() => { setEditandoIngresoId(ing.id); setCuentaEditTemp(ing.cuentaId || ""); }}
                        >
                          <PenLine size={11} />
                        </button>
                        <button className="text-[#A13D2E]" onClick={() => update((d) => { d.ingresos = d.ingresos.filter((x) => x.id !== ing.id); })}>
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card p-4">
          <div className="stamp text-[13px] text-[#7A7263] mb-3">TRANSFERENCIA ENTRE CUENTAS</div>
          {!transferForm ? (
            <button className="btn-primary" onClick={() => setTransferForm({ fecha: todayISO(), formaPago: "efectivo" })} disabled={data.cuentas.length < 2}><Plus size={14} /> Transferencia</button>
          ) : (
            <div className="space-y-2">
              <select className="ledger-input" value={transferForm.deCuentaId || ""} onChange={(e) => setTransferForm({ ...transferForm, deCuentaId: e.target.value })}>
                <option value="">De cuenta…</option>
                {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
              <select className="ledger-input" value={transferForm.aCuentaId || ""} onChange={(e) => setTransferForm({ ...transferForm, aCuentaId: e.target.value })}>
                <option value="">A cuenta…</option>
                {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
              <input className="ledger-input" type="number" placeholder="Monto" value={transferForm.monto || ""} onChange={(e) => setTransferForm({ ...transferForm, monto: e.target.value })} />
              <input className="ledger-input" type="date" value={transferForm.fecha} onChange={(e) => setTransferForm({ ...transferForm, fecha: e.target.value })} />
              <select className="ledger-input" value={transferForm.formaPago || "efectivo"} onChange={(e) => setTransferForm({ ...transferForm, formaPago: e.target.value })}>
                <option value="efectivo">Efectivo</option>
                <option value="cheque">Cheque</option>
                <option value="zelle">Zelle</option>
              </select>
              {transferForm.formaPago === "cheque" && (
                <input className="ledger-input" placeholder="Número de cheque" value={transferForm.numeroCheque || ""} onChange={(e) => setTransferForm({ ...transferForm, numeroCheque: e.target.value })} />
              )}
              <input className="ledger-input" placeholder="Concepto (ej. aporte de Boris)" value={transferForm.concepto || ""} onChange={(e) => setTransferForm({ ...transferForm, concepto: e.target.value })} />
              <label className="flex items-center gap-1.5 text-[12px] text-[#7A7263] cursor-pointer">
                <input type="checkbox" checked={!!transferForm.antesSociedad} onChange={(e) => setTransferForm({ ...transferForm, antesSociedad: e.target.checked })} />
                Se descuenta del dinero de antes de la sociedad
              </label>
              <div className="flex gap-2">
                <button className="btn-primary" onClick={addTransfer}><Check size={14} /> Guardar</button>
                <button className="text-sm text-[#7A7263] px-2" onClick={() => setTransferForm(null)}>Cancelar</button>
              </div>
            </div>
          )}
          {data.transferencias.length > 0 && (
            <div className="mt-3 pt-3 space-y-1" style={{ borderTop: `1px dashed ${LINE}` }}>
              {[...data.transferencias].sort((a, b) => (a.fecha < b.fecha ? 1 : -1)).map((tr) => {
                const de = data.cuentas.find((c) => c.id === tr.deCuentaId);
                const a = data.cuentas.find((c) => c.id === tr.aCuentaId);
                if (editandoTransferId === tr.id) {
                  return (
                    <div key={tr.id} className="py-1.5" style={{ borderBottom: `1px dashed ${LINE}` }}>
                      <div className="text-[11px] text-[#7A7263] mb-1">{money(tr.monto)} · {fmtDate(tr.fecha)}</div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[11px] text-[#7A7263] shrink-0">De:</span>
                        <select className="ledger-input text-xs flex-1" value={transferEditTemp.deCuentaId} onChange={(e) => setTransferEditTemp({ ...transferEditTemp, deCuentaId: e.target.value })}>
                          {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                        </select>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-[#7A7263] shrink-0">A:</span>
                        <select className="ledger-input text-xs flex-1" value={transferEditTemp.aCuentaId} onChange={(e) => setTransferEditTemp({ ...transferEditTemp, aCuentaId: e.target.value })}>
                          {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                        </select>
                      </div>
                      <div className="flex gap-1.5 mt-1.5">
                        <button
                          className="text-[11px] px-2 py-1 border"
                          style={{ borderColor: GREEN, color: GREEN }}
                          onClick={() => {
                            update((d) => {
                              const item = d.transferencias.find((x) => x.id === tr.id);
                              if (item) { item.deCuentaId = transferEditTemp.deCuentaId; item.aCuentaId = transferEditTemp.aCuentaId; }
                            });
                            setEditandoTransferId(null);
                          }}
                        >
                          <Check size={12} />
                        </button>
                        <button className="text-[11px] text-[#7A7263] px-1" onClick={() => setEditandoTransferId(null)}>Cancelar</button>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={tr.id} className="flex justify-between items-center text-[11px] text-[#7A7263]">
                    <span>
                      {fmtDate(tr.fecha)} · {de?.nombre || "—"} → {a?.nombre || "—"} · {formaPagoTexto(tr.formaPago, tr.numeroCheque)}
                      {tr.concepto ? ` · ${tr.concepto}` : ""}
                      {tr.antesSociedad && (
                        <span className="ml-1 text-[9px] uppercase px-1 py-0.5" style={{ background: "#FBE9D9", color: AMBER }}>Antes de la sociedad</span>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="mono">{money(tr.monto)}</span>
                      <button
                        className="text-[#7A7263]"
                        title="Cambiar las cuentas de esta transferencia"
                        onClick={() => { setEditandoTransferId(tr.id); setTransferEditTemp({ deCuentaId: tr.deCuentaId || "", aCuentaId: tr.aCuentaId || "" }); }}
                      >
                        <PenLine size={11} />
                      </button>
                      <button className="text-[#A13D2E]" onClick={() => update((d) => { d.transferencias = d.transferencias.filter((x) => x.id !== tr.id); })}>
                        <Trash2 size={11} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {cuentaModal && <CuentaMovimientosModal cuenta={cuentaModal} data={data} onClose={() => setCuentaModal(null)} />}
    </div>
  );
}

/* ---------------- Reembolsos ---------------- */
function Reembolsos({ data, update }) {
  const pendientes = calcPendientesPorPagador(data);

  const marcarReembolsado = (tipo, id) => {
    update((d) => {
      const list = tipo === "Material" ? d.materiales : d.nomina;
      const item = list.find((x) => x.id === id);
      if (item) item.reembolsado = true;
    });
  };

  return (
    <div>
      <SectionTitle sub="Calculado en automático según lo que cada socio o trabajador pagó de su bolsa">Reembolsos</SectionTitle>

      {pendientes.length === 0 && <Empty text="Nada pendiente de reembolsar por ahora." />}

      {pendientes.map((bucket) => (
        <div key={bucket.key} className="card p-4 mb-4">
          <div className="flex justify-between items-center mb-3">
            <div className="stamp text-[14px]">
              {bucket.nombre} <span className="text-[11px] text-[#7A7263] normal-case">({bucket.tipo === "empleado" ? "trabajador" : "socio"})</span>
            </div>
            <div className="mono text-lg font-semibold" style={{ color: bucket.pendiente ? RED : GREEN }}>{money(bucket.pendiente)}</div>
          </div>
          {bucket.items.length === 0 && <p className="text-[13px] text-[#7A7263]">Nada pendiente de reembolsar.</p>}
          {bucket.items.map((it) => {
            const trab = data.trabajos.find((t) => t.id === it.trabajoId);
            return (
              <div key={it.id} className="flex justify-between items-center py-1.5 text-sm border-b last:border-0" style={{ borderColor: LINE }}>
                <div>
                  <div>{it.tipo === "Material" ? it.descripcion : (data.empleados.find((e) => e.id === it.empleadoId)?.nombre || "Nómina")}</div>
                  <div className="text-[11px] text-[#7A7263]">{it.tipo} · {trab ? (trab.apodo || trab.nombre) : "sin trabajo"} · {fmtDate(it.fecha)}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="mono">{money(it.monto)}</span>
                  <button className="text-[11px] text-[#3B6E52] underline" onClick={() => marcarReembolsado(it.tipo, it.id)}>marcar pagado</button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ---------------- Reportes de cierre por trabajo ---------------- */
function Reportes({ data, update }) {
  const [openId, setOpenId] = useState(null);
  const [draftNotas, setDraftNotas] = useState({});
  const [reciboTrabajo, setReciboTrabajo] = useState(null);
  const [pagosPersonalTrabajo, setPagosPersonalTrabajo] = useState(null);

  const trabajosCerrados = [...data.trabajos]
    .filter((t) => t.estado === "cerrado")
    .sort((a, b) => {
      const ra = data.reportes.find((r) => r.trabajoId === a.id);
      const rb = data.reportes.find((r) => r.trabajoId === b.id);
      return (rb?.fechaCierre || "") < (ra?.fechaCierre || "") ? -1 : 1;
    });

  // Trabajos con al menos un ingreso registrado en una cuenta marcada como personal (CashApp, propinas, etc.)
  const trabajosConPersonal = data.trabajos
    .map((t) => {
      const ingresosPersonales = data.ingresos.filter(
        (i) => i.trabajoId === t.id && data.cuentas.find((c) => c.id === i.cuentaId)?.esPersonal
      );
      const totalIngresos = ingresosPersonales.reduce((s, i) => s + Number(i.monto || 0), 0);
      const esTrabajoPersonal = !!t.pagoPersonal;
      const total = totalIngresos + (esTrabajoPersonal ? Number(t.montoRecibidoPersonal || 0) : 0);
      const cantidad = ingresosPersonales.length + (esTrabajoPersonal ? 1 : 0);
      return { trabajo: t, total, cantidad, soloTrabajoPersonal: esTrabajoPersonal && ingresosPersonales.length === 0 };
    })
    .filter((x) => x.cantidad > 0)
    .sort((a, b) => (a.trabajo.fecha < b.trabajo.fecha ? 1 : -1));

  const guardarNotas = (trabajoId) => {
    update((d) => {
      const existing = d.reportes.find((r) => r.trabajoId === trabajoId);
      const notas = draftNotas[trabajoId] ?? existing?.notas ?? "";
      if (existing) existing.notas = notas;
      else d.reportes.push({ id: uid(), trabajoId, fechaCierre: todayISO(), notas });
    });
  };

  return (
    <div>
      <SectionTitle sub="Se genera cuando marcas un trabajo como cerrado, con el resumen completo de esa obra">
        Reportes de cierre
      </SectionTitle>

      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <div className="stamp text-[13px] text-[#7A7263] mb-3">CIERRE EMPRESA</div>
      {trabajosCerrados.length === 0 && (
        <Empty text="Aún no hay trabajos cerrados. Marca un trabajo como 'Cerrado' en la pestaña Trabajos para generar su reporte." />
      )}

      <div className="space-y-2">
        {trabajosCerrados.map((t) => {
          const c = calcTrabajo(t, data);
          const reporte = data.reportes.find((r) => r.trabajoId === t.id);
          const materialesT = data.materiales.filter((m) => m.trabajoId === t.id);
          const nominaT = data.nomina.filter((n) => n.trabajoId === t.id);
          const open = openId === t.id;
          return (
            <div key={t.id} className="card">
              <button className="w-full text-left p-4 flex justify-between items-center" onClick={() => setOpenId(open ? null : t.id)}>
                <div>
                  <div className="font-medium text-sm">{t.nombre}</div>
                  <div className="text-[12px] text-[#7A7263]">
                    {t.cliente} · cerrado {reporte?.fechaCierre ? fmtDate(reporte.fechaCierre) : ""}
                  </div>
                </div>
                <div className="mono text-sm font-semibold" style={{ color: c.ganancia >= 0 ? GREEN : RED }}>{money(c.ganancia)}</div>
              </button>

              {open && (
                <div style={{ borderTop: `1px dashed ${LINE}` }} className="p-4 pt-3">
                  <Row label="Estimado" value={money(Number(t.estimado))} />
                  <Row label="Materiales gastados" value={money(c.materiales)} accent={RED} />
                  <Row label="Mano de obra / nómina" value={money(c.manoDeObra)} accent={RED} />
                  {c.materialesAportadosPorCliente > 0 && (
                    <>
                      <Row label="Materiales que compró el cliente directo" value={money(c.materialesAportadosPorCliente)} />
                      <Row label="Estimado ajustado (estimado − esos materiales)" value={money(c.estimadoAjustado)} />
                    </>
                  )}
                  {c.reembolsoPorPersona.length > 0 && (
                    <div className="pl-3 mb-1 space-y-0.5">
                      {c.reembolsoPorPersona.map((r, i) => (
                        <div key={i} className="flex justify-between text-[11px]" style={{ color: AMBER }}>
                          <span>Reembolsar a {r.nombre} por {r.tipoLabel}</span>
                          <span className="mono">{money(r.monto)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <Row label={c.tienePagoReal ? "Ganancia real (según lo pagado)" : "Ganancia total"} value={money(c.tienePagoReal ? c.gananciaReal : c.ganancia)} bold accent={c.ganancia >= 0 ? GREEN : RED} />
                  <div className="grid grid-cols-2 gap-2 my-2">
                    {data.socios.map((s) => (
                      <div key={s.id} className="bg-[#F3EEE4] p-2 text-center">
                        <div className="text-[10px] text-[#7A7263] uppercase">{s.nombre}</div>
                        <div className="mono text-sm font-semibold">{money(c.mitadResto)}</div>
                        <div className="text-[9px] text-[#7A7263]">ganancia (ya restado reembolso)</div>
                      </div>
                    ))}
                  </div>
                  {c.totalReembolsosTrabajo > 0 && (
                    <div className="grid grid-cols-2 gap-2 mb-2">
                      {data.socios.map((s) => {
                        const reemb = c.reembolsoDeSocio(s.id);
                        if (reemb <= 0) return <div key={s.id} />;
                        return (
                          <div key={s.id} className="p-2 text-center" style={{ background: "#FBF3E3", border: "1px solid #E8D9A8" }}>
                            <div className="text-[10px] uppercase" style={{ color: "#8A6416" }}>+ reembolso a {s.nombre}</div>
                            <div className="mono text-sm font-semibold" style={{ color: "#8A6416" }}>{money(reemb)}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {materialesT.length > 0 && (
                    <div className="flex justify-between text-sm font-semibold mt-3 mb-1 pt-1" style={{ borderTop: `1px dashed ${LINE}` }}>
                      <span className="text-[#7A7263]">Materiales</span>
                      <span>{money(c.materiales)}</span>
                    </div>
                  )}

                  {nominaT.length > 0 && (
                    <>
                      <div className="stamp text-[12px] text-[#7A7263] mt-3 mb-1">MANO DE OBRA</div>
                      {nominaT.map((n) => (
                        <Row key={n.id} label={`${data.empleados.find((e) => e.id === n.empleadoId)?.nombre || "—"} · ${fmtDate(n.fecha)}`} value={money(n.monto)} />
                      ))}
                    </>
                  )}

                  <div className="stamp text-[12px] text-[#7A7263] mt-4 mb-2">NOTAS DE CIERRE</div>
                  <textarea
                    className="ledger-input"
                    rows={3}
                    placeholder="Observaciones finales, entrega, pendientes…"
                    value={draftNotas[t.id] ?? reporte?.notas ?? ""}
                    onChange={(e) => setDraftNotas({ ...draftNotas, [t.id]: e.target.value })}
                  />
                  <div className="flex gap-2 mt-3">
                    <button className="btn-primary" onClick={() => guardarNotas(t.id)}><Check size={14} /> Guardar reporte</button>
                    <button
                      className="text-sm flex items-center gap-1 px-3 border"
                      style={{ borderColor: LINE }}
                      onClick={() => setReciboTrabajo(t)}
                    >
                      <Receipt size={14} /> Ver recibo grande
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
        </div>

        <div>
          <div className="stamp text-[13px] mb-3" style={{ color: AMBER }}>CIERRE PERSONAL (CASHAPP / PROPINAS)</div>
          {trabajosConPersonal.length === 0 && (
            <Empty text="Aún no hay dinero registrado en cuentas personales (CashApp, propinas) ligado a un trabajo." />
          )}
          <div className="space-y-2">
            {trabajosConPersonal.map(({ trabajo: t, total }) => (
              <div key={t.id} className="card p-4 flex justify-between items-center">
                <div>
                  <div className="font-medium text-sm">{t.apodo || t.nombre}</div>
                  <div className="text-[12px] text-[#7A7263]">{t.cliente}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="mono text-sm font-semibold" style={{ color: AMBER }}>{money(total)}</span>
                  <button
                    className="text-[11px] underline flex items-center gap-1"
                    style={{ color: "#7A7263" }}
                    onClick={() => setPagosPersonalTrabajo(t)}
                  >
                    <Receipt size={13} /> Ver reporte
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {reciboTrabajo && (
        <ReciboModal
          trabajo={data.trabajos.find((x) => x.id === reciboTrabajo.id) || reciboTrabajo}
          data={data}
          update={update}
          onClose={() => setReciboTrabajo(null)}
        />
      )}
      {pagosPersonalTrabajo && (
        <PagosTrabajoModal
          trabajo={data.trabajos.find((x) => x.id === pagosPersonalTrabajo.id) || pagosPersonalTrabajo}
          tipo="personal"
          data={data}
          update={update}
          onClose={() => setPagosPersonalTrabajo(null)}
        />
      )}
    </div>
  );
}

/* ---------------- Modal configuración (socios + rotación) ---------------- */
function SociosModal({ data, update, onClose }) {
  const [names, setNames] = useState(data.socios.map((s) => s.nombre));
  const [empresaNombre, setEmpresaNombre] = useState(data.empresaNombre || "");
  const [rot, setRot] = useState(data.rotacionNomina || { activa: false, socioInicioId: "s1", mesInicio: todayISO().slice(0, 7) });
  const [claveActual, setClaveActual] = useState("");
  const [claveNueva1, setClaveNueva1] = useState("");
  const [claveNueva2, setClaveNueva2] = useState("");
  const [claveMsg, setClaveMsg] = useState("");

  const save = () => {
    update((d) => {
      d.socios.forEach((s, i) => (s.nombre = names[i] || s.nombre));
      d.empresaNombre = empresaNombre || d.empresaNombre;
      d.rotacionNomina = rot;
    });
    onClose();
  };

  const cambiarClave = () => {
    const claveGuardada = data.claveEdicion || CLAVE_EDICION;
    if (claveActual !== claveGuardada) {
      setClaveMsg("La contraseña actual no es correcta.");
      return;
    }
    if (!claveNueva1 || claveNueva1.length < 4) {
      setClaveMsg("La nueva contraseña debe tener al menos 4 caracteres.");
      return;
    }
    if (claveNueva1 !== claveNueva2) {
      setClaveMsg("Las dos contraseñas nuevas no coinciden.");
      return;
    }
    update((d) => { d.claveEdicion = claveNueva1; });
    setClaveActual("");
    setClaveNueva1("");
    setClaveNueva2("");
    setClaveMsg("¡Contraseña cambiada! Úsala la próxima vez que desbloquees.");
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40 p-4" onClick={onClose}>
      <div className="card p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <div className="stamp text-[14px]">CONFIGURACIÓN</div>
          <button onClick={onClose}><X size={16} /></button>
        </div>

        <div className="stamp text-[12px] text-[#7A7263] mb-2">NOMBRE DE LA EMPRESA</div>
        <input className="ledger-input mb-4" value={empresaNombre} onChange={(e) => setEmpresaNombre(e.target.value)} />

        <div className="stamp text-[12px] text-[#7A7263] mb-2">NOMBRES DE LOS SOCIOS</div>
        {names.map((n, i) => (
          <input key={i} className="ledger-input mb-2" value={n} onChange={(e) => setNames(names.map((x, j) => (j === i ? e.target.value : x)))} />
        ))}

        <div className="stamp text-[12px] text-[#7A7263] mt-4 mb-2">ROTACIÓN DE MANO DE OBRA</div>
        <label className="flex items-center gap-2 text-sm mb-2">
          <input type="checkbox" checked={rot.activa} onChange={(e) => setRot({ ...rot, activa: e.target.checked })} />
          Alternar mensualmente quién paga la nómina
        </label>
        {rot.activa && (
          <>
            <select className="ledger-input mb-2" value={rot.socioInicioId} onChange={(e) => setRot({ ...rot, socioInicioId: e.target.value })}>
              {data.socios.map((s, i) => <option key={s.id} value={s.id}>{names[i]} empieza pagando</option>)}
            </select>
            <label className="text-[11px] text-[#7A7263] block mb-1">Mes en que empieza esta rotación</label>
            <input
              className="ledger-input mb-1"
              type="month"
              value={rot.mesInicio}
              onChange={(e) => setRot({ ...rot, mesInicio: e.target.value })}
            />
            <p className="text-[11px] text-[#7A7263] mt-1">Ese mes le toca a quien elegiste arriba; al siguiente mes le toca al otro socio, y así se va alternando.</p>
          </>
        )}

        <button className="btn-primary mt-4" onClick={save}><Check size={14} /> Guardar</button>

        <div className="stamp text-[12px] text-[#7A7263] mt-6 mb-2">CAMBIAR CONTRASEÑA DE EDICIÓN</div>
        <input type="password" className="ledger-input mb-2" placeholder="Contraseña actual" value={claveActual} onChange={(e) => { setClaveActual(e.target.value); setClaveMsg(""); }} />
        <input type="password" className="ledger-input mb-2" placeholder="Contraseña nueva" value={claveNueva1} onChange={(e) => { setClaveNueva1(e.target.value); setClaveMsg(""); }} />
        <input type="password" className="ledger-input mb-2" placeholder="Repite la contraseña nueva" value={claveNueva2} onChange={(e) => { setClaveNueva2(e.target.value); setClaveMsg(""); }} />
        {claveMsg && <p className="text-[12px] mb-2" style={{ color: claveMsg.startsWith("¡") ? GREEN : "#A13D2E" }}>{claveMsg}</p>}
        <button className="btn-primary" onClick={cambiarClave}><Check size={14} /> Cambiar contraseña</button>
      </div>
    </div>
  );
}

/* ---------------- Recibo grande, estilo tique de ferretería ---------------- */
/* ---------------- Hojas imprimibles sencillas (materiales/bitácora por trabajo, movimientos por cuenta) ---------------- */
function HojaImprimible({ titulo, subtitulo, onClose, children, customHeader, ancho }) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start sm:items-center justify-center p-3 overflow-y-auto">
      <div className={`bg-white w-full my-4 ${ancho === "ancho" ? "max-w-2xl" : "max-w-md"}`}>
        <div className="no-print flex justify-between items-center p-3 bg-[#1E2A38] sticky top-0 z-10">
          <button onClick={() => window.print()} className="btn-primary"><Printer size={15} /> Imprimir / PDF</button>
          <button onClick={onClose} className="text-white"><X size={20} /></button>
        </div>
        <div id="recibo-print" className={customHeader ? "p-6" : "p-6"} style={{ fontFamily: customHeader ? "Arial, Helvetica, sans-serif" : "'JetBrains Mono', monospace", color: "#111" }}>
          {customHeader ? (
            customHeader
          ) : (
            <>
              <div className="text-center mb-4">
                <Receipt size={28} className="mx-auto mb-1" />
                <div style={{ fontFamily: "'Special Elite', monospace" }} className="text-xl font-bold uppercase tracking-wide">{titulo}</div>
                {subtitulo && <div className="text-sm mt-1">{subtitulo}</div>}
              </div>
              <div className="recibo-linea" />
            </>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

function MapaTrabajosModal({ data, update, onClose }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markersRef = useRef({});
  const [geocodificando, setGeocodificando] = useState(false);
  const [trabajoAbierto, setTrabajoAbierto] = useState(null);
  const [linkInputs, setLinkInputs] = useState({});
  const [errorLink, setErrorLink] = useState({});
  const [corrigiendoId, setCorrigiendoId] = useState(null);

  const colorEstado = (t) => {
    if (t.estado === "cerrado") return "#3C7A5A"; // verde: concluido
    if (t.progreso === "en_proceso") return "#C98A2C"; // ámbar: en proceso
    return "#5B7A9D"; // azul: iniciado
  };

  const etiquetaEstado = (t) => {
    if (t.estado === "cerrado") return "Concluido";
    if (t.progreso === "en_proceso") return "En proceso";
    return "Iniciado";
  };

  const cambiarEstado = (t, nuevo) => {
    update((d) => {
      const trab = d.trabajos.find((x) => x.id === t.id);
      if (nuevo === "concluido") {
        trab.estado = "cerrado";
        trab.progreso = "en_proceso";
      } else if (nuevo === "en_proceso") {
        trab.estado = "activo";
        trab.progreso = "en_proceso";
      } else {
        trab.estado = "activo";
        trab.progreso = "iniciado";
      }
    });
  };

  // Inicializa el mapa una sola vez
  useEffect(() => {
    if (mapInstance.current || !mapRef.current) return;
    mapInstance.current = L.map(mapRef.current).setView([33.75, -84.39], 9); // vista inicial: área de Atlanta
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
      maxZoom: 19,
    }).addTo(mapInstance.current);
    return () => {
      mapInstance.current?.remove();
      mapInstance.current = null;
    };
  }, []);

  // Geocodifica (una sola vez por trabajo) las direcciones que no tengan coordenadas guardadas todavía
  useEffect(() => {
    const pendientes = data.trabajos.filter((t) => t.direccion && (!t.mapLat || !t.mapLng));
    if (pendientes.length === 0) return;
    let cancelado = false;
    (async () => {
      setGeocodificando(true);
      for (const t of pendientes) {
        if (cancelado) break;
        const coords = await geocodificarDireccion(t.direccion);
        if (coords) {
          update((d) => {
            const trab = d.trabajos.find((x) => x.id === t.id);
            if (trab) { trab.mapLat = coords.lat; trab.mapLng = coords.lng; }
          });
        }
        await new Promise((r) => setTimeout(r, 1100)); // respeta el límite del servicio gratuito (máx. 1 por segundo)
      }
      setGeocodificando(false);
    })();
    return () => { cancelado = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.trabajos.map((t) => t.id + "|" + (t.direccion || "")).join(",")]);

  // Dibuja/actualiza las tachuelas cada vez que cambian los trabajos
  useEffect(() => {
    if (!mapInstance.current) return;
    const trabajosConCoords = data.trabajos.filter((t) => t.mapLat && t.mapLng);
    const idsActuales = new Set(trabajosConCoords.map((t) => t.id));

    // Quita tachuelas de trabajos que ya no tienen coordenadas (o se borraron)
    Object.keys(markersRef.current).forEach((id) => {
      if (!idsActuales.has(id)) {
        markersRef.current[id].remove();
        delete markersRef.current[id];
      }
    });

    trabajosConCoords.forEach((t) => {
      const icon = L.divIcon({
        className: "",
        html: `<div style="background:${colorEstado(t)};width:16px;height:16px;border-radius:50%;border:2px solid white;box-shadow:0 0 3px rgba(0,0,0,0.5);"></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      if (markersRef.current[t.id]) {
        markersRef.current[t.id].setLatLng([t.mapLat, t.mapLng]);
        markersRef.current[t.id].setIcon(icon);
      } else {
        const marker = L.marker([t.mapLat, t.mapLng], { icon }).addTo(mapInstance.current);
        marker.on("click", () => setTrabajoAbierto(t.id));
        markersRef.current[t.id] = marker;
      }
    });

    // Si hay al menos un trabajo con coordenadas, ajusta la vista para que se vean todas las tachuelas
    if (trabajosConCoords.length > 0) {
      const bounds = L.latLngBounds(trabajosConCoords.map((t) => [t.mapLat, t.mapLng]));
      mapInstance.current.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.trabajos]);

  const trabSeleccionado = data.trabajos.find((t) => t.id === trabajoAbierto);
  const sinDireccion = data.trabajos.filter((t) => !t.direccion).length;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40 p-2 sm:p-4" onClick={onClose}>
      <div className="card w-full max-w-3xl h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center p-3" style={{ borderBottom: `1px solid ${LINE}` }}>
          <div>
            <div className="stamp text-[13px]">MAPA DE TRABAJOS</div>
            <div className="text-[11px] text-[#7A7263]">
              {geocodificando ? "Ubicando direcciones en el mapa…" : "Toca una tachuela para ver o cambiar el estado del trabajo"}
              {sinDireccion > 0 ? ` · ${sinDireccion} trabajo(s) sin dirección` : ""}
            </div>
          </div>
          <button onClick={onClose}><X size={18} /></button>
        </div>

        <div className="flex gap-3 px-3 py-2 text-[11px] text-[#7A7263]" style={{ borderBottom: `1px solid ${LINE}` }}>
          <span className="flex items-center gap-1"><span style={{ width: 10, height: 10, borderRadius: "50%", background: "#5B7A9D", display: "inline-block" }} /> Iniciado</span>
          <span className="flex items-center gap-1"><span style={{ width: 10, height: 10, borderRadius: "50%", background: "#C98A2C", display: "inline-block" }} /> En proceso</span>
          <span className="flex items-center gap-1"><span style={{ width: 10, height: 10, borderRadius: "50%", background: "#3C7A5A", display: "inline-block" }} /> Concluido</span>
        </div>

        {(() => {
          const sinUbicar = data.trabajos.filter((t) => t.direccion && (!t.mapLat || !t.mapLng));
          if (sinUbicar.length === 0) return null;
          return (
            <div className="px-3 py-2" style={{ borderBottom: `1px solid ${LINE}`, maxHeight: 220, overflowY: "auto" }}>
              <div className="text-[11px] text-[#7A7263] mb-2">
                Estos trabajos tienen dirección, pero el mapa no la encontró solo. En Google Maps, busca la dirección, <b>mantén el dedo presionado sobre el punto exacto</b> hasta que caiga un pin — arriba te van a salir dos números (las coordenadas). Tócalos para copiarlos, y pégalos aquí:
              </div>
              <div className="space-y-2">
                {sinUbicar.map((t) => (
                  <div key={t.id} className="flex items-center gap-1.5">
                    <span className="text-[11px] flex-1 truncate">{t.apodo || t.nombre}</span>
                    <input
                      className="ledger-input text-xs flex-1"
                      placeholder="Ej. 33.749, -84.388"
                      value={linkInputs[t.id] || ""}
                      onChange={(e) => setLinkInputs({ ...linkInputs, [t.id]: e.target.value })}
                    />
                    <button
                      className="text-[11px] px-2 py-1.5 border shrink-0"
                      style={{ borderColor: GREEN, color: GREEN }}
                      onClick={() => {
                        const coords = extraerCoordsDeLinkMaps(linkInputs[t.id]);
                        if (!coords) {
                          setErrorLink({ ...errorLink, [t.id]: true });
                          return;
                        }
                        update((d) => {
                          const trab = d.trabajos.find((x) => x.id === t.id);
                          if (trab) { trab.mapLat = coords.lat; trab.mapLng = coords.lng; }
                        });
                        setLinkInputs({ ...linkInputs, [t.id]: "" });
                        setErrorLink({ ...errorLink, [t.id]: false });
                      }}
                    >
                      <Check size={12} />
                    </button>
                  </div>
                ))}
              </div>
              {Object.values(errorLink).some(Boolean) && (
                <p className="text-[11px] mt-1" style={{ color: "#A13D2E" }}>
                  No pude leer eso — asegúrate de pegar los dos números de coordenadas (o un link completo con @ en el medio).
                </p>
              )}
            </div>
          );
        })()}

        <div className="flex-1 relative">
          <div ref={mapRef} className="absolute inset-0" />
        </div>

        {trabSeleccionado && (
          <div className="p-3" style={{ borderTop: `1px solid ${LINE}` }}>
            <div className="font-medium text-sm mb-0.5">{trabSeleccionado.apodo || trabSeleccionado.nombre}</div>
            <div className="text-[11px] text-[#7A7263] mb-2">{trabSeleccionado.direccion}</div>
            <div className="flex gap-2 mb-2">
              {[
                { key: "iniciado", label: "Iniciado", color: "#5B7A9D" },
                { key: "en_proceso", label: "En proceso", color: "#C98A2C" },
                { key: "concluido", label: "Concluido", color: "#3C7A5A" },
              ].map((op) => {
                const activo = etiquetaEstado(trabSeleccionado) === op.label;
                return (
                  <button
                    key={op.key}
                    className="text-[11px] px-2.5 py-1.5 border"
                    style={{
                      borderColor: op.color,
                      background: activo ? op.color : "#fff",
                      color: activo ? "#fff" : op.color,
                    }}
                    onClick={() => cambiarEstado(trabSeleccionado, op.key)}
                  >
                    {op.label}
                  </button>
                );
              })}
            </div>
            {corrigiendoId === trabSeleccionado.id ? (
              <div className="flex items-center gap-1.5">
                <input
                  className="ledger-input text-xs flex-1"
                  placeholder="Pega aquí las coordenadas correctas"
                  value={linkInputs[trabSeleccionado.id] || ""}
                  onChange={(e) => setLinkInputs({ ...linkInputs, [trabSeleccionado.id]: e.target.value })}
                  autoFocus
                />
                <button
                  className="text-[11px] px-2 py-1.5 border shrink-0"
                  style={{ borderColor: GREEN, color: GREEN }}
                  onClick={() => {
                    const coords = extraerCoordsDeLinkMaps(linkInputs[trabSeleccionado.id]);
                    if (!coords) { setErrorLink({ ...errorLink, [trabSeleccionado.id]: true }); return; }
                    update((d) => {
                      const trab = d.trabajos.find((x) => x.id === trabSeleccionado.id);
                      if (trab) { trab.mapLat = coords.lat; trab.mapLng = coords.lng; }
                    });
                    setLinkInputs({ ...linkInputs, [trabSeleccionado.id]: "" });
                    setErrorLink({ ...errorLink, [trabSeleccionado.id]: false });
                    setCorrigiendoId(null);
                  }}
                >
                  <Check size={12} />
                </button>
                <button className="text-[11px] text-[#7A7263] px-1.5 shrink-0" onClick={() => setCorrigiendoId(null)}>Cancelar</button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <button className="text-[11px] text-[#7A7263] underline" onClick={() => setCorrigiendoId(trabSeleccionado.id)}>
                  Corregir ubicación en el mapa
                </button>
                {trabSeleccionado.mapLat && (
                  <button
                    className="text-[11px] underline"
                    style={{ color: "#A13D2E" }}
                    onClick={() => {
                      update((d) => {
                        const trab = d.trabajos.find((x) => x.id === trabSeleccionado.id);
                        if (trab) { trab.mapLat = null; trab.mapLng = null; }
                      });
                      setTrabajoAbierto(null);
                    }}
                  >
                    <Trash2 size={11} className="inline mr-0.5" /> Eliminar ubicación
                  </button>
                )}
              </div>
            )}
            {errorLink[trabSeleccionado.id] && (
              <p className="text-[11px] mt-1" style={{ color: "#A13D2E" }}>No pude leer esas coordenadas, intenta de nuevo.</p>
            )}
          </div>
        )}

        <div className="p-3" style={{ borderTop: `1px solid ${LINE}`, maxHeight: 180, overflowY: "auto" }}>
          <div className="stamp text-[11px] text-[#7A7263] mb-1.5">TODOS LOS TRABAJOS</div>
          <div className="space-y-1">
            {data.trabajos.map((t) => (
              <button
                key={t.id}
                className="w-full flex items-center gap-2 text-left text-[12px] py-0.5"
                onClick={() => {
                  setTrabajoAbierto(t.id);
                  if (t.mapLat && t.mapLng && mapInstance.current) {
                    mapInstance.current.setView([t.mapLat, t.mapLng], 15);
                  }
                }}
              >
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: colorEstado(t), display: "inline-block", flexShrink: 0 }} />
                <span className="flex-1 truncate">{t.apodo || t.nombre}</span>
                <span className="text-[10px] text-[#7A7263] shrink-0">{etiquetaEstado(t)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PagosPersonalesModal({ data, onClose }) {
  const trabajosPersonales = data.trabajos.filter((t) => t.pagoPersonal).sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
  const total = trabajosPersonales.reduce((s, t) => s + Number(t.estimado || 0), 0);
  return (
    <HojaImprimible titulo="Trabajos por fuera" subtitulo="Pagados a cuenta personal (no son de la empresa)" onClose={onClose}>
      {trabajosPersonales.length === 0 && <div className="text-sm py-2">— sin trabajos marcados como pago personal —</div>}
      {trabajosPersonales.map((t) => {
        const c = calcTrabajo(t, data);
        return (
          <div key={t.id} className="py-2" style={{ borderBottom: "1px dashed #ccc" }}>
            <div className="flex justify-between text-base">
              <span className="pr-2">{t.numeroTrabajo ? `#${t.numeroTrabajo} · ` : ""}{t.apodo || t.nombre}</span>
              <span className="whitespace-nowrap font-semibold">{money(t.estimado || 0)}</span>
            </div>
            <div className="text-xs" style={{ color: "#888" }}>
              {t.cliente ? `${t.cliente} · ` : ""}{fmtDate(t.fecha)}
              {t.direccion ? ` · ${t.direccion}` : ""}
            </div>
            <div className="text-xs" style={{ color: "#888" }}>
              Materiales: {money(c.materiales)} · Mano de obra: {money(c.manoDeObra)}
            </div>
            {t.montoRecibidoPersonal > 0 && (
              <div className="text-xs" style={{ color: "#888" }}>
                Cobrado: {money(t.montoRecibidoPersonal)} · {t.formaPagoPersonal === "cheque" ? `Cheque${t.numeroChequePersonal ? ` #${t.numeroChequePersonal}` : ""}` : t.formaPagoPersonal === "zelle" ? "Zelle" : "Efectivo"}
              </div>
            )}
          </div>
        );
      })}
      <div className="recibo-linea" />
      <div className="flex justify-between text-lg font-bold">
        <span>TOTAL ESTIMADO</span>
        <span>{money(total)}</span>
      </div>
    </HojaImprimible>
  );
}

function PagosTrabajoModal({ trabajo, data, update, onClose, tipo }) {
  const ingresosTrabajo = data.ingresos.filter((i) => i.trabajoId === trabajo.id);
  const esDeEmpresa = (i) => !data.cuentas.find((c) => c.id === i.cuentaId)?.esPersonal;
  const items = ingresosTrabajo.filter((i) => (tipo === "personal" ? !esDeEmpresa(i) : esDeEmpresa(i)));
  const incluyeTrabajoPersonal = tipo === "personal" && !!trabajo.pagoPersonal && Number(trabajo.montoRecibidoPersonal || 0) > 0;

  const itemsPendientes = items.filter((i) => i.estado === "pendiente");
  const itemsCobrados = items.filter((i) => i.estado !== "pendiente");
  const totalCobrado = itemsCobrados.reduce((s, i) => s + Number(i.monto || 0), 0) + (incluyeTrabajoPersonal ? Number(trabajo.montoRecibidoPersonal) : 0);
  const totalPendienteCobro = itemsPendientes.reduce((s, i) => s + Number(i.monto || 0), 0);
  const total = totalCobrado + totalPendienteCobro;

  const repartoPagado = trabajo.repartoPagado?.[tipo] || {};
  const [fechaEditando, setFechaEditando] = useState(null);
  const [fechaTemp, setFechaTemp] = useState("");
  const clienteInfo = data.clientes.find((cl) => cl.nombre === trabajo.cliente);
  const tareas = (trabajo.descripcionTrabajo || "").split("\n").filter((linea) => linea.trim());
  const nombresCuentas = [...new Set(items.map((i) => data.cuentas.find((c) => c.id === i.cuentaId)?.nombre).filter(Boolean))];
  const subtituloCuenta = nombresCuentas.length > 0 ? nombresCuentas.join(" / ") : tipo === "personal" ? "Cuenta personal" : "Cuenta de la empresa";

  // Mano de obra ligada a este trabajo, con quién puso el dinero de cada pago.
  // Si un socio pagó de su bolsillo (a reembolsar), eso siempre es una deuda de la EMPRESA con ese socio —
  // sin importar qué cuenta haya elegido solo para anotar de dónde salió el dinero físico.
  // Solo cuando NO es reembolso a un socio (pagado directo por "empresa"), la cuenta elegida decide si es personal o empresa.
  const nominaT = data.nomina.filter((n) => {
    if (n.trabajoId !== trabajo.id) return false;
    const esReembolsoASocio = !!data.socios.find((s) => s.id === n.pagadoPor);
    if (esReembolsoASocio) return tipo === "empresa";
    const esPagoDeCuentaPersonal = !!data.cuentas.find((c) => c.id === n.cuentaId)?.esPersonal;
    return tipo === "personal" ? esPagoDeCuentaPersonal : !esPagoDeCuentaPersonal;
  });
  const pagadoConTexto = (n) => {
    const socio = data.socios.find((s) => s.id === n.pagadoPor);
    if (socio) return `dinero propio de ${socio.nombre}`;
    if (n.pagadoPor === "cliente") return "dinero del cliente";
    if ((n.pagadoPor || "").startsWith("empleado:")) {
      const emp = data.empleados.find((e) => e.id === n.pagadoPor.slice("empleado:".length));
      return `dinero propio de ${emp?.nombre || "otro trabajador"}`;
    }
    return "fondos del trabajo";
  };
  const totalManoDeObra = nominaT.reduce((s, n) => s + Number(n.monto || 0), 0);
  const manoDeObraPendiente = nominaT.filter((n) => n.estado === "pendiente").reduce((s, n) => s + Number(n.monto || 0), 0);

  // Reembolsos: mano de obra ya pagada, pero con dinero de un socio (no de la empresa/cliente)
  const reembolsosPorSocio = {};
  nominaT.forEach((n) => {
    const socio = data.socios.find((s) => s.id === n.pagadoPor);
    if (socio && n.estado !== "pendiente" && !n.reembolsado) {
      reembolsosPorSocio[socio.id] = (reembolsosPorSocio[socio.id] || 0) + Number(n.monto || 0);
    }
  });
  const totalReembolsos = Object.values(reembolsosPorSocio).reduce((s, v) => s + v, 0);

  const gananciaNeta = total - manoDeObraPendiente - totalReembolsos;
  const cuotaBase = gananciaNeta / 2;
  const hayPendiente = totalPendienteCobro > 0;

  // Nota explicativa, generada automáticamente según lo que hay pendiente/reembolsable
  const notas = [];
  nominaT.forEach((n) => {
    const empleadoNombre = data.empleados.find((e) => e.id === n.empleadoId)?.nombre || "un trabajador";
    const socio = data.socios.find((s) => s.id === n.pagadoPor);
    if (n.estado === "pendiente") {
      notas.push(`A ${empleadoNombre} todavía no se le ha pagado; se le paga ${hayPendiente ? "apenas se cobre el pago pendiente" : "de los fondos del trabajo"}.`);
    } else if (socio && !n.reembolsado) {
      notas.push(`A ${empleadoNombre} ya se le pagó, pero con dinero que ${socio.nombre} puso de su bolsillo, por eso a ${socio.nombre} se le debe reembolsar ${money(n.monto)}.`);
    }
  });

  const marcarPagado = (socioId, fecha) => {
    update((d) => {
      const t = d.trabajos.find((x) => x.id === trabajo.id);
      if (!t.repartoPagado) t.repartoPagado = {};
      if (!t.repartoPagado[tipo]) t.repartoPagado[tipo] = {};
      t.repartoPagado[tipo][socioId] = { pagado: true, fecha: fecha || todayISO() };
    });
    setFechaEditando(null);
  };
  const marcarPendiente = (socioId) => {
    update((d) => {
      const t = d.trabajos.find((x) => x.id === trabajo.id);
      if (!t.repartoPagado) t.repartoPagado = {};
      if (!t.repartoPagado[tipo]) t.repartoPagado[tipo] = {};
      t.repartoPagado[tipo][socioId] = { pagado: false, fecha: "" };
    });
  };

  const numeroReporte = (trabajo.numeroTrabajo || "").toString().padStart(4, "0") || "—";
  const metodosPago = [
    ...(incluyeTrabajoPersonal ? [trabajo.formaPagoPersonal === "cheque" ? "Cheque" : trabajo.formaPagoPersonal === "zelle" ? "Zelle" : "Efectivo"] : []),
    ...items.map((i) => (i.formaPago === "cheque" ? "Cheque" : i.formaPago === "zelle" ? "Zelle" : "Efectivo")),
  ];
  const metodoPagoTexto = [...new Set(metodosPago)].join(" / ") || "—";
  const Th = ({ children, right }) => (
    <th className="text-[11px] uppercase font-bold py-1.5" style={{ color: "#888", textAlign: right ? "right" : "left", borderBottom: "1px solid #000" }}>{children}</th>
  );
  const Td = ({ children, right, bold }) => (
    <td className={`text-sm py-1.5 ${bold ? "font-bold" : ""}`} style={{ textAlign: right ? "right" : "left", borderBottom: "1px dashed #ccc" }}>{children}</td>
  );

  const pillEstilo = (estado) => {
    if (estado === "pagado") return { background: "#E8F5E9", color: "#2E7D32" };
    if (estado === "parcial" || estado === "en_espera") return { background: "#FFF3E0", color: "#B26A00" };
    return { background: "#FDECEA", color: "#C62828" };
  };
  const Pill = ({ estado, children }) => (
    <span className="text-[11px] font-bold px-2.5 py-1" style={{ borderRadius: 3, ...pillEstilo(estado) }}>{children}</span>
  );
  const NavyTh = ({ children, right, center }) => (
    <th
      className="text-[12px] font-bold py-2 px-2.5"
      style={{ background: colorPrimario, color: "#fff", textAlign: right ? "right" : center ? "center" : "left" }}
    >
      {children}
    </th>
  );
  const NavyTd = ({ children, right, center, bold }) => (
    <td
      className={`text-sm py-2 px-2.5 ${bold ? "font-bold" : ""}`}
      style={{ textAlign: right ? "right" : center ? "center" : "left", borderBottom: "1px solid #D9D9D9" }}
    >
      {children}
    </td>
  );
  const estadoGeneral = hayPendiente ? "pendiente" : "pagado";
  const colorPrimario = tipo === "personal" ? "#1F3864" : "#1B5E20";
  const colorClaro = tipo === "personal" ? "#DCE6F1" : "#E1F0E3";
  const estadoGeneralTexto = hayPendiente ? "PENDIENTE — ESPERANDO COBRO DEL CLIENTE" : "PAGADO EN SU TOTALIDAD";

  return (
    <HojaImprimible
      ancho="ancho"
      onClose={onClose}
      customHeader={
        <>
          <div className="flex justify-between items-start gap-4 mb-2">
            <div>
              <div className="text-[22px] font-bold" style={{ color: colorPrimario }}>{(data.empresaNombre || "MB Services").toUpperCase()}</div>
              <div className="text-[11px] mt-0.5" style={{ color: "#6B6B6B" }}>Construcción y Remodelación</div>
            </div>
            <div className="text-right px-4 py-3 shrink-0" style={{ background: colorPrimario, color: "#fff", borderRadius: 4, minWidth: 220 }}>
              <div className="text-[15px] font-bold mb-1.5">REPORTE DE CUENTA {tipo === "personal" ? "PERSONAL" : "EMPRESA"}</div>
              <div className="text-[10.5px]" style={{ opacity: 0.9 }}>N.º de Reporte: <b>{numeroReporte}</b></div>
              <div className="text-[10.5px]" style={{ opacity: 0.9 }}>Fecha de emisión: {fmtDate(todayISO())}</div>
            </div>
          </div>
          <hr style={{ border: "none", borderTop: `2px solid ${colorPrimario}`, margin: "12px 0 20px" }} />
        </>
      }
    >
      <div className="grid grid-cols-2 mb-6" style={{ background: "#F7F9FC", border: "1px solid #D9D9D9", borderRadius: 4 }}>
        <div className="p-4" style={{ borderRight: "1px solid #D9D9D9" }}>
          <div className="text-[11px] font-bold uppercase mb-1.5" style={{ color: colorPrimario }}>Cliente</div>
          <div className="text-sm"><b>{trabajo.cliente || "—"}</b></div>
          <div className="text-sm mt-0.5">{[trabajo.managerCliente, clienteInfo?.telefono, trabajo.direccion].filter(Boolean).join(" · ") || "—"}</div>
          <div className="text-[11px] mt-1" style={{ color: "#6B6B6B" }}>
            Cuenta: {tipo === "personal" ? "Personal" : "Empresa"} ({tipo === "personal" ? "azul" : "verde"} = {tipo === "personal" ? "reporte de cuenta personal" : "reporte oficial de la empresa"})
          </div>
        </div>
        <div className="p-4">
          <div className="text-[11px] font-bold uppercase mb-1.5" style={{ color: colorPrimario }}>Información del trabajo</div>
          <div className="text-sm">Fecha: {trabajo.fecha && trabajo.fechaTerminado && trabajo.fecha !== trabajo.fechaTerminado ? `${fmtDate(trabajo.fecha)} — ${fmtDate(trabajo.fechaTerminado)}` : trabajo.fecha ? fmtDate(trabajo.fecha) : "—"}</div>
          <div className="text-sm mt-0.5">Trabajo realizado: {tareas.length > 0 ? tareas.join(", ") : "—"}</div>
          <div className="text-[11px] mt-1" style={{ color: "#6B6B6B" }}>Método de pago: {metodoPagoTexto}{hayPendiente ? " (en tránsito)" : ""}</div>
        </div>
      </div>

      {(itemsCobrados.length > 0 || incluyeTrabajoPersonal) && (
        <div className="mb-6">
          <div className="text-[11px] font-bold uppercase mb-2" style={{ color: colorPrimario }}>Pagos recibidos</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <NavyTh>Fecha</NavyTh>
                <NavyTh>Descripción</NavyTh>
                <NavyTh center>Método</NavyTh>
                <NavyTh right>Monto</NavyTh>
              </tr>
            </thead>
            <tbody>
              {incluyeTrabajoPersonal && (
                <tr>
                  <NavyTd>{trabajo.fecha ? fmtDate(trabajo.fecha) : "—"}</NavyTd>
                  <NavyTd>Pago del trabajo{trabajo.numeroChequePersonal ? ` #${trabajo.numeroChequePersonal}` : ""}</NavyTd>
                  <NavyTd center>{trabajo.formaPagoPersonal === "cheque" ? "Cheque" : trabajo.formaPagoPersonal === "zelle" ? "Zelle" : "Efectivo"}</NavyTd>
                  <NavyTd right bold>{money(trabajo.montoRecibidoPersonal)}</NavyTd>
                </tr>
              )}
              {itemsCobrados.map((i) => (
                <tr key={i.id}>
                  <NavyTd>{fmtDate(i.fecha)}</NavyTd>
                  <NavyTd>
                    {i.concepto || "Pago del trabajo"}
                    {i.numeroCheque ? ` #${i.numeroCheque}` : ""}
                    {i.numeroInvoice ? ` · Invoice #${i.numeroInvoice}` : ""}
                  </NavyTd>
                  <NavyTd center>{formaPagoTextoStandalone(i.formaPago, i.numeroCheque).split(" ")[0]}</NavyTd>
                  <NavyTd right bold>{money(i.monto)}</NavyTd>
                </tr>
              ))}
              <tr>
                <td colSpan={3} className="text-sm font-bold py-2 px-2.5 text-right" style={{ background: colorClaro, color: colorPrimario }}>TOTAL RECIBIDO</td>
                <td className="text-sm font-bold py-2 px-2.5 text-right" style={{ background: colorClaro, color: colorPrimario }}>{money(totalCobrado)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {!hayPendiente && itemsCobrados.length === 0 && !incluyeTrabajoPersonal && (
        <div className="text-sm py-2 mb-6">— sin pagos registrados en esta cuenta —</div>
      )}

      {itemsPendientes.length > 0 && (
        <div className="mb-6">
          <div className="text-[11px] font-bold uppercase mb-2" style={{ color: colorPrimario }}>Pago pendiente de cobro</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <NavyTh>Fecha esperada</NavyTh>
                <NavyTh>Descripción</NavyTh>
                <NavyTh center>Método</NavyTh>
                <NavyTh right>Monto</NavyTh>
              </tr>
            </thead>
            <tbody>
              {itemsPendientes.map((i) => (
                <tr key={i.id}>
                  <NavyTd>{i.fechaEsperada ? fmtDate(i.fechaEsperada) : "Por confirmar"}</NavyTd>
                  <NavyTd>{i.concepto || "Pago del trabajo"}</NavyTd>
                  <NavyTd center>{formaPagoTextoStandalone(i.formaPago, i.numeroCheque).split(" ")[0]}</NavyTd>
                  <NavyTd right bold>{money(i.monto)}</NavyTd>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nominaT.length > 0 && (
        <div className="mb-6">
          <div className="text-[11px] font-bold uppercase mb-2" style={{ color: colorPrimario }}>Mano de obra / Gastos</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <NavyTh>Trabajador / Socio</NavyTh>
                <NavyTh>Pagado con</NavyTh>
                <NavyTh right>Monto</NavyTh>
                <NavyTh center>Estado</NavyTh>
                <NavyTh center>Fecha / Condición</NavyTh>
              </tr>
            </thead>
            <tbody>
              {nominaT.map((n) => {
                const empleadoNombre = data.empleados.find((e) => e.id === n.empleadoId)?.nombre || "—";
                const pendiente = n.estado === "pendiente";
                return (
                  <tr key={n.id}>
                    <NavyTd>{empleadoNombre}</NavyTd>
                    <NavyTd>{pendiente ? "—" : pagadoConTexto(n)}</NavyTd>
                    <NavyTd right bold>{money(n.monto)}</NavyTd>
                    <NavyTd center><Pill estado={pendiente ? "pendiente" : "pagado"}>{pendiente ? "Pendiente" : "Pagado"}</Pill></NavyTd>
                    <NavyTd center>{pendiente ? "Al cobrar el pago pendiente" : (n.fecha ? fmtDate(n.fecha) : "—")}</NavyTd>
                  </tr>
                );
              })}
              <tr>
                <td colSpan={4} className="text-sm font-bold py-2 px-2.5 text-right" style={{ background: "#FFF3E0", color: "#B26A00" }}>TOTAL MANO DE OBRA / GASTOS</td>
                <td className="text-sm font-bold py-2 px-2.5 text-right" style={{ background: "#FFF3E0", color: "#B26A00" }}>{money(totalManoDeObra)}</td>
              </tr>
            </tbody>
          </table>
          {notas.length > 0 && (
            <div className="text-[11px] mt-2" style={{ color: "#6B6B6B", lineHeight: 1.5 }}>{notas.join(" ")}</div>
          )}
        </div>
      )}

      <div className="mb-6">
        <div className="text-[11px] font-bold uppercase mb-2" style={{ color: colorPrimario }}>
          {hayPendiente ? "Ganancia neta proyectada a repartir" : "Ganancia neta a repartir"}
        </div>
        <table style={{ width: "100%" }}>
          <tbody>
            <tr>
              <td className="text-sm py-1.5 pl-2.5">{hayPendiente ? "Total recibido / a cobrar" : "Total recibido"}</td>
              <td className="text-sm py-1.5 text-right">{money(total)}</td>
            </tr>
            {manoDeObraPendiente > 0 && (
              <tr>
                <td className="text-sm py-1.5 pl-2.5">(–) Pago pendiente a trabajadores</td>
                <td className="text-sm py-1.5 text-right">-{money(manoDeObraPendiente)}</td>
              </tr>
            )}
            {Object.entries(reembolsosPorSocio).map(([socioId, monto]) => (
              <tr key={socioId}>
                <td className="text-sm py-1.5 pl-2.5">(–) Reembolso a {data.socios.find((s) => s.id === socioId)?.nombre}</td>
                <td className="text-sm py-1.5 text-right">-{money(monto)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: `1px solid ${colorPrimario}` }}>
              <td className="text-[14px] font-bold py-2.5 px-2.5" style={{ background: colorClaro, color: colorPrimario }}>
                GANANCIA NETA (50 / 50)
              </td>
              <td className="text-[14px] font-bold py-2.5 px-2.5 text-right" style={{ background: colorClaro, color: colorPrimario }}>
                {money(gananciaNeta)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mb-6">
        <div className="text-[11px] font-bold uppercase mb-2" style={{ color: colorPrimario }}>Liquidación final por socio</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <NavyTh>Socio</NavyTh>
              <NavyTh right>Reembolso</NavyTh>
              <NavyTh right>50% Ganancia</NavyTh>
              <NavyTh right>Total a recibir</NavyTh>
              <NavyTh center>Estado</NavyTh>
            </tr>
          </thead>
          <tbody>
            {data.socios.map((s) => {
              const estado = repartoPagado[s.id];
              const pagado = !!estado?.pagado;
              const reembolsoPropio = reembolsosPorSocio[s.id] || 0;
              const totalSocio = cuotaBase + reembolsoPropio;
              return (
                <tr key={s.id}>
                  <NavyTd>{s.nombre}</NavyTd>
                  <NavyTd right>{money(reembolsoPropio)}</NavyTd>
                  <NavyTd right>{money(cuotaBase)}</NavyTd>
                  <NavyTd right bold>{money(totalSocio)}</NavyTd>
                  <NavyTd center>
                    <Pill estado={pagado ? "pagado" : hayPendiente ? "en_espera" : "pendiente"}>
                      {pagado ? "Pagado" : hayPendiente ? "En espera" : "Pendiente"}
                    </Pill>
                    {pagado && estado?.fecha && <div className="text-[10px] mt-1" style={{ color: "#6B6B6B" }}>{fmtDate(estado.fecha)}</div>}
                  </NavyTd>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="no-print flex gap-4 mt-2">
          {data.socios.map((s) => {
            const estado = repartoPagado[s.id];
            const pagado = !!estado?.pagado;
            return fechaEditando === s.id ? (
              <div key={s.id} className="flex items-center gap-1.5">
                <input type="date" className="ledger-input text-[11px] py-1" value={fechaTemp} onChange={(e) => setFechaTemp(e.target.value)} />
                <button className="text-[10px] underline" style={{ color: "#2E7D32" }} onClick={() => marcarPagado(s.id, fechaTemp)}>Guardar</button>
                <button className="text-[10px] underline" style={{ color: "#6B6B6B" }} onClick={() => setFechaEditando(null)}>Cancelar</button>
              </div>
            ) : (
              <button
                key={s.id}
                className="text-[10px] underline"
                style={{ color: "#6B6B6B" }}
                onClick={() => {
                  if (pagado) marcarPendiente(s.id);
                  else { setFechaTemp(todayISO()); setFechaEditando(s.id); }
                }}
              >
                {s.nombre}: marcar como {pagado ? "pendiente" : "pagado"}
              </button>
            );
          })}
        </div>
      </div>

      <div
        className="flex items-center gap-2.5 px-4 py-3 mb-6 text-sm"
        style={{ ...pillEstilo(estadoGeneral), border: `1px solid ${estadoGeneral === "pagado" ? "#2E7D32" : "#C62828"}`, borderRadius: 4 }}
      >
        <span>ESTADO GENERAL DEL TRABAJO:</span>
        <b>{estadoGeneralTexto}</b>
      </div>

      <div style={{ borderTop: "1px solid #D9D9D9", paddingTop: 10 }}>
        <div className="text-[9.5px]" style={{ color: "#6B6B6B", lineHeight: 1.5 }}>
          Este reporte fue generado automáticamente por el sistema de administración de {data.empresaNombre || "MB Services"} · mb-services-app.vercel.app
          <br />
          Documento interno — uso exclusivo de los socios.
          <br />
          Generado: {fmtDate(todayISO())}, {new Date().toLocaleTimeString("es-US", { hour: "numeric", minute: "2-digit" })}
        </div>
      </div>
    </HojaImprimible>
  );
}

function MaterialesTrabajoModal({ trabajo, data, onClose }) {
  const materialesT = data.materiales.filter((m) => m.trabajoId === trabajo.id).sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  const total = materialesT.reduce((s, m) => s + materialNeto(m), 0);
  return (
    <HojaImprimible titulo="Materiales" subtitulo={trabajo.apodo || trabajo.nombre} onClose={onClose}>
      {materialesT.length === 0 && <div className="text-sm py-2">— sin materiales registrados —</div>}
      {materialesT.map((m) => (
        <div key={m.id} className="py-1.5" style={{ borderBottom: "1px dashed #ccc" }}>
          <div className="flex justify-between text-base">
            <span className="pr-2">{m.descripcion}</span>
            <span className="whitespace-nowrap font-semibold">{money(materialNeto(m))}</span>
          </div>
          <div className="text-xs" style={{ color: "#888" }}>
            {fmtDate(m.fecha)} · pagado por {pagadorNombre(data, m.pagadoPor)}
            {m.montoDevuelto > 0 ? ` · devolviste ${money(m.montoDevuelto)}` : ""}
          </div>
        </div>
      ))}
      <div className="recibo-linea" />
      <div className="flex justify-between text-lg font-bold">
        <span>TOTAL</span>
        <span>{money(total)}</span>
      </div>
    </HojaImprimible>
  );
}

function BitacoraTrabajoModal({ trabajo, data, onClose }) {
  const bitacoraT = data.bitacora.filter((b) => b.trabajoId === trabajo.id).sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  return (
    <HojaImprimible titulo="Actividad diaria" subtitulo={trabajo.apodo || trabajo.nombre} onClose={onClose}>
      {bitacoraT.length === 0 && <div className="text-sm py-2">— sin actividad registrada —</div>}
      {bitacoraT.map((b) => {
        const participantes = b.participantes || [];
        return (
          <div key={b.id} className="py-2" style={{ borderBottom: "1px dashed #ccc" }}>
            <div className="text-sm font-bold">{fmtDate(b.fecha)}</div>
            <div className="text-sm mb-1">{b.descripcion}</div>
            {participantes.length > 0 && (
              <div className="text-xs" style={{ color: "#666" }}>
                {participantes.map((p) => `${nombreParticipante(data, p)} (${p.estado === "completado" ? "completado" : "pendiente"})`).join(" · ")}
              </div>
            )}
          </div>
        );
      })}
    </HojaImprimible>
  );
}

function CuentaMovimientosModal({ cuenta, data, onClose }) {
  const ingresosC = data.ingresos.filter((i) => i.cuentaId === cuenta.id);
  const transfSalida = data.transferencias.filter((t) => t.deCuentaId === cuenta.id);
  const transfEntrada = data.transferencias.filter((t) => t.aCuentaId === cuenta.id);
  const materialesC = data.materiales.filter((m) => m.cuentaId === cuenta.id);
  const nominaC = data.nomina.filter((n) => n.cuentaId === cuenta.id);

  const movimientos = [
    ...ingresosC.map((i) => ({ fecha: i.fecha, tipo: "Ingreso de cliente", detalle: (i.concepto || "") + (i.numeroInvoice ? ` (invoice #${i.numeroInvoice})` : "") + (i.fechaFacturaEnviada ? ` · enviado ${fmtDate(i.fechaFacturaEnviada)}` : "") + (i.antesSociedad ? " · Antes de la sociedad" : ""), monto: i.monto, signo: 1, formaPago: formaPagoTextoStandalone(i.formaPago, i.numeroCheque) })),
    ...transfEntrada.map((t) => ({ fecha: t.fecha, tipo: "Transferencia recibida", detalle: `de ${data.cuentas.find((c) => c.id === t.deCuentaId)?.nombre || "—"}` + (t.concepto ? ` · ${t.concepto}` : "") + (t.antesSociedad ? " · Antes de la sociedad" : ""), monto: t.monto, signo: 1, formaPago: formaPagoTextoStandalone(t.formaPago, t.numeroCheque) })),
    ...transfSalida.map((t) => ({ fecha: t.fecha, tipo: "Transferencia enviada", detalle: `a ${data.cuentas.find((c) => c.id === t.aCuentaId)?.nombre || "—"}` + (t.concepto ? ` · ${t.concepto}` : "") + (t.antesSociedad ? " · Antes de la sociedad" : ""), monto: t.monto, signo: -1, formaPago: formaPagoTextoStandalone(t.formaPago, t.numeroCheque) })),
    ...materialesC.map((m) => ({
      fecha: m.fecha,
      tipo: "Material",
      detalle: m.descripcion + (m.numeroInvoice ? ` (invoice #${m.numeroInvoice})` : ""),
      monto: materialNeto(m),
      signo: -1,
      formaPago: m.numeroCheque ? `Cheque #${m.numeroCheque}` : "",
    })),
    ...nominaC.map((n) => ({
      fecha: n.fecha,
      tipo: "Nómina",
      detalle: (data.empleados.find((e) => e.id === n.empleadoId)?.nombre || "—") + (n.antesSociedad ? " · Antes de la sociedad" : ""),
      monto: n.monto,
      signo: -1,
      formaPago: n.numeroCheque ? `Cheque #${n.numeroCheque}` : "",
    })),
  ].sort((a, b) => (a.fecha < b.fecha ? 1 : -1));

  const saldo = calcCuentaSaldo(cuenta, data);

  return (
    <HojaImprimible titulo="Movimientos de cuenta" subtitulo={cuenta.nombre} onClose={onClose}>
      {movimientos.length === 0 && <div className="text-sm py-2">— sin movimientos —</div>}
      {movimientos.map((m, i) => (
        <div key={i} className="py-1.5" style={{ borderBottom: "1px dashed #ccc" }}>
          <div className="flex justify-between text-base">
            <span className="pr-2">{m.tipo}{m.detalle ? ` — ${m.detalle}` : ""}</span>
            <span className="whitespace-nowrap font-semibold" style={{ color: m.signo > 0 ? "#1E6B3E" : "#A13D2E" }}>
              {m.signo > 0 ? "+" : "-"}{money(m.monto)}
            </span>
          </div>
          <div className="text-xs" style={{ color: "#888" }}>{fmtDate(m.fecha)}{m.formaPago ? ` · ${m.formaPago}` : ""}</div>
        </div>
      ))}
      <div className="recibo-linea" />
      <div className="flex justify-between text-lg font-bold">
        <span>SALDO ACTUAL</span>
        <span>{money(saldo)}</span>
      </div>
    </HojaImprimible>
  );
}

// Versión standalone de formaPagoTexto (fuera del componente Cuentas) para usar en el modal de movimientos
function formaPagoTextoStandalone(fp, numCheque) {
  if (!fp) return "";
  const base = fp === "cheque" ? "Cheque" : fp === "zelle" ? "Zelle" : "Efectivo";
  return fp === "cheque" && numCheque ? `${base} #${numCheque}` : base;
}

function ReciboModal({ trabajo, data, update, onClose }) {
  const c = calcTrabajo(trabajo, data);
  const reporte = data.reportes.find((r) => r.trabajoId === trabajo.id);
  const materialesT = data.materiales.filter((m) => m.trabajoId === trabajo.id);
  const nominaT = data.nomina.filter((n) => n.trabajoId === trabajo.id);
  const clienteInfo = data.clientes.find((cl) => cl.nombre === trabajo.cliente);

  // Reembolsos pendientes de ESTE trabajo únicamente (socios o trabajadores que pagaron de su bolsa)
  const reembolsosTrabajo = {};
  const acumular = (item, tipo) => {
    const p = item.pagadoPor;
    if (!p || p === "empresa" || p === "cliente" || p === "sindefinir" || item.reembolsado) return;
    const nombre = pagadorNombre(data, p);
    const monto = tipo === "Material" ? materialNeto(item) : Number(item.monto);
    if (!reembolsosTrabajo[p]) reembolsosTrabajo[p] = { nombre, materiales: 0, nomina: 0, total: 0, items: [] };
    if (tipo === "Material") reembolsosTrabajo[p].materiales += monto;
    else reembolsosTrabajo[p].nomina += monto;
    reembolsosTrabajo[p].total += monto;
    reembolsosTrabajo[p].items.push({ tipo, desc: tipo === "Material" ? (item.descripcion || "Material") : (data.empleados.find((e) => e.id === item.empleadoId)?.nombre || "Mano de obra"), invoice: item.numeroInvoice || "", monto });
  };
  materialesT.forEach((m) => acumular(m, "Material"));
  nominaT.forEach((n) => acumular(n, "Nómina"));
  const listaReembolsos = Object.values(reembolsosTrabajo);

  // Primero se reembolsa a quien puso dinero de su bolsa, y lo que resta se divide 50/50 entre los socios.
  // Si ya se confirmó cuánto pagó realmente el cliente (estimadoPagado), se usa ese número en vez del estimado completo.
  const gananciaParaReparto = c.tienePagoReal ? c.gananciaReal : c.ganancia;
  const gananciaBase = c.tienePagoReal ? Number(trabajo.estimadoPagado) : Number(trabajo.estimado);
  const totalReembolsosTrabajo = listaReembolsos.reduce((s, r) => s + r.total, 0);
  const restoARepartir = gananciaParaReparto - totalReembolsosTrabajo;
  const mitadResto = restoARepartir / 2;
  const cuotaBase = gananciaParaReparto / 2;
  const reembolsoDeSocio = (socioId) => reembolsosTrabajo[socioId]?.total || 0;

  const repartoCierre = trabajo.repartoPagadoCierre || {};
  const [fechaEditando, setFechaEditando] = useState(null);
  const [fechaTemp, setFechaTemp] = useState("");
  const marcarPagadoCierre = (socioId, fecha) => {
    update((d) => {
      const t = d.trabajos.find((x) => x.id === trabajo.id);
      if (!t.repartoPagadoCierre) t.repartoPagadoCierre = {};
      t.repartoPagadoCierre[socioId] = { pagado: true, fecha: fecha || todayISO() };
    });
    setFechaEditando(null);
  };
  const marcarPendienteCierre = (socioId) => {
    update((d) => {
      const t = d.trabajos.find((x) => x.id === trabajo.id);
      if (!t.repartoPagadoCierre) t.repartoPagadoCierre = {};
      t.repartoPagadoCierre[socioId] = { pagado: false, fecha: "" };
    });
  };

  const colorPrimario = "#1B5E20";
  const colorClaro = "#E1F0E3";
  const Th = ({ children, right, center }) => (
    <th className="text-[12px] font-bold py-2 px-2.5" style={{ background: colorPrimario, color: "#fff", textAlign: right ? "right" : center ? "center" : "left" }}>{children}</th>
  );
  const Td = ({ children, right, center, bold }) => (
    <td className={`text-sm py-2 px-2.5 ${bold ? "font-bold" : ""}`} style={{ textAlign: right ? "right" : center ? "center" : "left", borderBottom: "1px solid #D9D9D9" }}>{children}</td>
  );
  const Pill = ({ estado, children }) => (
    <span
      className="text-[11px] font-bold px-2.5 py-1"
      style={{
        borderRadius: 3,
        background: estado === "pagado" ? "#E8F5E9" : "#FFF3E0",
        color: estado === "pagado" ? "#2E7D32" : "#B26A00",
      }}
    >
      {children}
    </span>
  );

  return (
    <HojaImprimible
      ancho="ancho"
      onClose={onClose}
      customHeader={
        <>
          <div className="flex justify-between items-start gap-4 mb-2">
            <div>
              <div className="text-[22px] font-bold" style={{ color: colorPrimario }}>{(data.empresaNombre || "MB Services").toUpperCase()}</div>
              <div className="text-[11px] mt-0.5" style={{ color: "#6B6B6B" }}>Construcción y Remodelación</div>
            </div>
            <div className="text-right px-4 py-3 shrink-0" style={{ background: colorPrimario, color: "#fff", borderRadius: 4, minWidth: 220 }}>
              <div className="text-[15px] font-bold mb-1.5">REPORTE DE CIERRE</div>
              <div className="text-[10.5px]" style={{ opacity: 0.9 }}>Trabajo #{trabajo.numeroTrabajo || "—"}</div>
              <div className="text-[10.5px]" style={{ opacity: 0.9 }}>Fecha de cierre: {reporte?.fechaCierre ? fmtDate(reporte.fechaCierre) : "—"}</div>
            </div>
          </div>
          <hr style={{ border: "none", borderTop: `2px solid ${colorPrimario}`, margin: "12px 0 20px" }} />
        </>
      }
    >
      <div className="text-center mb-4">
        <div className="text-xl font-bold uppercase">{trabajo.nombre}</div>
      </div>

      <div className="grid grid-cols-2 mb-6" style={{ background: "#F7F9FC", border: "1px solid #D9D9D9", borderRadius: 4 }}>
        <div className="p-4" style={{ borderRight: "1px solid #D9D9D9" }}>
          <div className="text-[11px] font-bold uppercase mb-1.5" style={{ color: colorPrimario }}>Cliente</div>
          <div className="text-sm"><b>{trabajo.cliente || "—"}</b></div>
          <div className="text-sm mt-0.5">{[trabajo.managerCliente, clienteInfo?.telefono, trabajo.direccion].filter(Boolean).join(" · ") || "—"}</div>
          <div className="text-[11px] mt-1" style={{ color: "#6B6B6B" }}>Cuenta: Empresa (verde = reporte oficial de la empresa)</div>
        </div>
        <div className="p-4">
          <div className="text-[11px] font-bold uppercase mb-1.5" style={{ color: colorPrimario }}>Información del trabajo</div>
          {trabajo.descripcionTrabajo && trabajo.descripcionTrabajo.split("\n").filter((linea) => linea.trim()).length > 0 && (
            <div className="text-sm">Trabajo realizado: {trabajo.descripcionTrabajo.split("\n").filter((linea) => linea.trim()).join(", ")}</div>
          )}
          <div className="text-[11px] mt-1" style={{ color: "#6B6B6B" }}>
            {trabajo.fecha && trabajo.fechaTerminado
              ? `${fmtDate(trabajo.fecha)} — ${fmtDate(trabajo.fechaTerminado)} (${Math.max(1, Math.round((new Date(trabajo.fechaTerminado) - new Date(trabajo.fecha)) / 86400000) + 1)} día(s))`
              : trabajo.fecha
              ? `Inicio ${fmtDate(trabajo.fecha)}`
              : "—"}
          </div>
        </div>
      </div>

      <div className="mb-6">
        <div className="text-[11px] font-bold uppercase mb-2" style={{ color: colorPrimario }}>I. Resumen de ingresos (cliente)</div>
        <table style={{ width: "100%" }}>
          <tbody>
            <tr><td className="text-sm py-1.5 font-bold">Presupuesto inicial (estimado)</td><td className="text-sm py-1.5 text-right font-bold">{money(Number(trabajo.estimado))}</td></tr>
            {c.tienePagoReal && (
              <>
                <tr style={{ borderTop: "1px solid #000" }}>
                  <td className="text-sm py-1.5 font-bold">Total final pagado por el cliente</td>
                  <td className="text-sm py-1.5 text-right font-bold">{money(Number(trabajo.estimadoPagado))}</td>
                </tr>
                {(() => {
                  const dif = Number(trabajo.estimadoPagado) - Number(trabajo.estimado);
                  return (
                    <tr style={{ color: dif >= 0 ? "#2E7D32" : "#C62828" }}>
                      <td className="text-sm py-1.5">Diferencia {dif >= 0 ? "a favor" : "a la baja"}</td>
                      <td className="text-sm py-1.5 text-right">{dif >= 0 ? "+" : ""}{money(dif)}</td>
                    </tr>
                  );
                })()}
              </>
            )}
          </tbody>
        </table>
      </div>

      <div className="mb-6">
        <div className="text-[11px] font-bold uppercase mb-2" style={{ color: colorPrimario }}>II. Gastos y costos generales de la obra</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <Th>Descripción del rubro</Th>
              <Th center>Tipo de gasto</Th>
              <Th right>Monto</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <Td>Materiales de la obra (subtotal)</Td>
              <Td center>Egreso directo</Td>
              <Td right bold>{money(c.materiales)}</Td>
            </tr>
            <tr>
              <Td>Mano de obra ejecutada (subtotal)</Td>
              <Td center>Egreso directo</Td>
              <Td right bold>{money(c.manoDeObra)}</Td>
            </tr>
            {c.materialesAportadosPorCliente > 0 && (
              <tr>
                <Td>Materiales comprados directo por el cliente</Td>
                <Td center>Deducción</Td>
                <Td right bold>{money(c.materialesAportadosPorCliente)}</Td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mb-6">
        <div className="text-[11px] font-bold uppercase mb-2" style={{ color: colorPrimario }}>III. Deudas y retenciones pendientes</div>
        {nominaT.filter((n) => n.estado === "pendiente").length === 0 && listaReembolsos.length === 0 ? (
          <div className="text-sm" style={{ color: "#888" }}>— sin pendientes —</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <Th>Destinatario / Proveedor</Th>
                <Th>Concepto</Th>
                <Th center>Estado</Th>
                <Th right>Monto retenido</Th>
              </tr>
            </thead>
            <tbody>
              {nominaT.filter((n) => n.estado === "pendiente").map((n) => (
                <tr key={n.id}>
                  <Td>{data.empleados.find((e) => e.id === n.empleadoId)?.nombre || "—"}</Td>
                  <Td>Mano de obra pendiente</Td>
                  <Td center><Pill estado="pendiente">Pendiente</Pill></Td>
                  <Td right bold>{money(n.monto)}</Td>
                </tr>
              ))}
              {listaReembolsos.map((r) => (
                <tr key={r.nombre}>
                  <Td>{r.nombre}</Td>
                  <Td>{r.materiales > 0 && r.nomina > 0 ? "Gastos" : r.materiales > 0 ? "Materiales" : "Mano de obra"} (reembolso)</Td>
                  <Td center><Pill estado="pendiente">Pendiente</Pill></Td>
                  <Td right bold>{money(r.total)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mb-6">
        <div className="text-[11px] font-bold uppercase mb-2" style={{ color: colorPrimario }}>IV. Balance final, reembolsos y distribución</div>
        <table style={{ width: "100%" }}>
          <tbody>
            <tr><td className="text-sm py-1.5">{c.tienePagoReal ? "Total recibido del cliente" : "Presupuesto (estimado)"}</td><td className="text-sm py-1.5 text-right font-bold">{money(gananciaBase)}</td></tr>
            {c.materialesAportadosPorCliente > 0 && (
              <tr><td className="text-sm py-1.5" style={{ color: "#888" }}>(−) Menos materiales pagados por cliente</td><td className="text-sm py-1.5 text-right" style={{ color: "#888" }}>-{money(c.materialesAportadosPorCliente)}</td></tr>
            )}
            <tr><td className="text-sm py-1.5" style={{ color: "#888" }}>(−) Menos materiales de la obra</td><td className="text-sm py-1.5 text-right" style={{ color: "#888" }}>-{money(c.materiales)}</td></tr>
            <tr><td className="text-sm py-1.5" style={{ color: "#888" }}>(−) Menos mano de obra ejecutada</td><td className="text-sm py-1.5 text-right" style={{ color: "#888" }}>-{money(c.manoDeObra)}</td></tr>
            <tr style={{ borderTop: `1px solid ${colorPrimario}` }}>
              <td className="text-[14px] font-bold py-2.5 px-2.5" style={{ background: colorClaro, color: colorPrimario }}>GANANCIA NETA TOTAL (A REPARTIR)</td>
              <td className="text-[14px] font-bold py-2.5 px-2.5 text-right" style={{ background: colorClaro, color: colorPrimario }}>{money(gananciaParaReparto)}</td>
            </tr>
            <tr><td className="text-sm py-1.5" style={{ color: "#888" }}>Cuota base por socio (50% / 50%)</td><td className="text-sm py-1.5 text-right" style={{ color: "#888" }}>{money(cuotaBase)} c/u</td></tr>
          </tbody>
        </table>
      </div>

      <div className="mb-6">
        <div className="text-[11px] font-bold uppercase mb-2" style={{ color: colorPrimario }}>V. Distribución final de efectivo (a pagar a cada uno)</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <Th>Socio</Th>
              <Th right>Reembolso</Th>
              <Th right>50% Ganancia</Th>
              <Th right>Total a recibir</Th>
              <Th center>Estado</Th>
            </tr>
          </thead>
          <tbody>
            {data.socios.map((s) => {
              const reembolsoPropio = reembolsoDeSocio(s.id);
              const estado = repartoCierre[s.id];
              const pagado = !!estado?.pagado;
              return (
                <tr key={s.id}>
                  <Td>{s.nombre}</Td>
                  <Td right>{money(reembolsoPropio)}</Td>
                  <Td right>{money(cuotaBase)}</Td>
                  <Td right bold>{money(cuotaBase + reembolsoPropio)}</Td>
                  <Td center>
                    <Pill estado={pagado ? "pagado" : "pendiente"}>{pagado ? "Pagado" : "Pendiente"}</Pill>
                    {pagado && estado?.fecha && <div className="text-[10px] mt-1" style={{ color: "#888" }}>{fmtDate(estado.fecha)}</div>}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="no-print flex gap-4 mt-2">
          {data.socios.map((s) => {
            const estado = repartoCierre[s.id];
            const pagado = !!estado?.pagado;
            return fechaEditando === s.id ? (
              <div key={s.id} className="flex items-center gap-1.5">
                <input type="date" className="ledger-input text-[11px] py-1" value={fechaTemp} onChange={(e) => setFechaTemp(e.target.value)} />
                <button className="text-[10px] underline" style={{ color: GREEN }} onClick={() => marcarPagadoCierre(s.id, fechaTemp)}>Guardar</button>
                <button className="text-[10px] underline" style={{ color: "#7A7263" }} onClick={() => setFechaEditando(null)}>Cancelar</button>
              </div>
            ) : (
              <button
                key={s.id}
                className="text-[10px] underline"
                style={{ color: "#7A7263" }}
                onClick={() => {
                  if (pagado) marcarPendienteCierre(s.id);
                  else { setFechaTemp(todayISO()); setFechaEditando(s.id); }
                }}
              >
                {s.nombre}: marcar como {pagado ? "pendiente" : "pagado"}
              </button>
            );
          })}
        </div>
      </div>

      {reporte?.notas && (
        <div className="mb-6">
          <div className="text-[11px] font-bold uppercase mb-2" style={{ color: colorPrimario }}>Notas</div>
          <div className="text-sm whitespace-pre-wrap">{reporte.notas}</div>
        </div>
      )}

      <div
        className="flex items-center gap-2.5 px-4 py-3 mb-6 text-sm"
        style={{ background: "#E8F5E9", border: "1px solid #2E7D32", borderRadius: 4 }}
      >
        <span>ESTADO GENERAL DEL TRABAJO:</span>
        <b style={{ color: "#2E7D32" }}>CERRADO</b>
      </div>

      <div style={{ borderTop: "1px solid #D9D9D9", paddingTop: 10 }}>
        <div className="text-[9.5px]" style={{ color: "#6B6B6B", lineHeight: 1.5 }}>
          Este reporte fue generado automáticamente por el sistema de administración de {data.empresaNombre || "MB Services"} · mb-services-app.vercel.app
          <br />
          Documento interno — uso exclusivo de los socios.
          <br />
          Generado: {fmtDate(todayISO())}, {new Date().toLocaleTimeString("es-US", { hour: "numeric", minute: "2-digit" })}
        </div>
      </div>
    </HojaImprimible>
  );
}

/* ---------------- Lista numerada (para "trabajo a realizar") ---------------- */
function NumberedListEditor({ value, onChange }) {
  const items = (value || "").split("\n");
  const displayItems = items.length ? items : [""];

  const updateItem = (idx, text) => {
    const next = [...displayItems];
    next[idx] = text;
    onChange(next.join("\n"));
  };
  const addItem = () => onChange([...displayItems, ""].join("\n"));
  const removeItem = (idx) => onChange(displayItems.filter((_, i) => i !== idx).join("\n"));

  return (
    <div className="space-y-1.5">
      {displayItems.map((item, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <span className="text-xs text-[#7A7263] w-4 text-right shrink-0">{idx + 1}.</span>
          <input
            className="flex-1 border text-sm py-1.5 px-2 outline-none"
            style={{ borderColor: LINE }}
            value={item}
            onChange={(e) => updateItem(idx, e.target.value)}
            placeholder={`Paso ${idx + 1}`}
          />
          {displayItems.length > 1 && (
            <button type="button" onClick={() => removeItem(idx)} className="text-[#A13D2E] shrink-0">
              <X size={14} />
            </button>
          )}
        </div>
      ))}
      <button type="button" onClick={addItem} className="text-[11px] text-[#7A7263] underline">
        + Agregar paso
      </button>
    </div>
  );
}

function Empty({ text }) {
  return <p className="text-[13px] text-[#7A7263] italic py-2">{text}</p>;
}
