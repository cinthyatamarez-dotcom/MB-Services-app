import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  LayoutDashboard, Briefcase, Users, Package, Landmark, ArrowLeftRight,
  ClipboardList, Plus, X, Check, Trash2, Loader2, Settings, Camera, ImageOff, Printer, Receipt, Sparkles, PenLine, Download, ShieldAlert, CalendarDays, Tag, Building2, Phone, Mail, Hash
} from "lucide-react";
import { db, storage } from "./firebase";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { ref, uploadString, getDownloadURL } from "firebase/storage";

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

  if (!data) {
    return (
      <div style={{ background: PAPER }} className="min-h-screen flex items-center justify-center">
        <Loader2 className="animate-spin text-stone-500" size={28} />
      </div>
    );
  }

  const update = (fn) => {
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
            onClick={() => setShowSocios(true)}
            className="text-[#C9C1B0] hover:text-white transition-colors"
            title="Configurar socios"
          >
            <Settings size={18} />
          </button>
        </div>
      </header>

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
        {tab === "trabajos" && <Trabajos data={data} update={update} />}
        {tab === "clientes" && <Clientes data={data} update={update} />}
        {tab === "bitacora" && <Bitacora data={data} update={update} />}
        {tab === "nomina" && <Nomina data={data} update={update} />}
        {tab === "materiales" && <Materiales data={data} update={update} onViewPhoto={setLightbox} />}
        {tab === "cuentas" && <Cuentas data={data} update={update} />}
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
      .recibo-linea{border-bottom:2px dashed #333;margin:10px 0}
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
    if (pagador === "empresa" || pagador === "cliente") return;
    const key = pagador + "|" + tipoLabel;
    if (!reembolsoMap[key]) reembolsoMap[key] = { nombre: pagadorNombre(data, pagador), tipoLabel, monto: 0 };
    reembolsoMap[key].monto += montoOverride !== undefined ? montoOverride : Number(item.monto);
  };
  materialesPropios.forEach((m) => acumularReembolso(m, "materiales", materialNeto(m)));
  nominaItems.forEach((n) => acumularReembolso(n, "nómina"));
  const reembolsoPorPersona = Object.values(reembolsoMap).sort((a, b) => a.nombre.localeCompare(b.nombre) || a.tipoLabel.localeCompare(b.tipoLabel));

  // El estimado se descuenta automáticamente por lo que el cliente ya compró directo (con su propio dinero).
  // Ejemplo: estimado $12,000, el cliente compró $3,000 en materiales por su cuenta → el estimado ajustado queda en $9,000.
  const estimadoAjustado = Number(t.estimado || 0) - materialesAportadosPorCliente;
  const ganancia = estimadoAjustado - materiales - manoDeObra;
  // Si ya se sabe cuánto pagó realmente el cliente, ese número YA viene neto (sin los materiales que compró él mismo),
  // así que no se le vuelve a restar materialesAportadosPorCliente — se usa tal cual.
  const tienePagoReal = t.estimadoPagado !== undefined && t.estimadoPagado !== null && t.estimadoPagado !== "";
  const gananciaReal = tienePagoReal ? Number(t.estimadoPagado || 0) - materiales - manoDeObra : ganancia;
  return {
    materiales,
    materialesAportadosPorCliente,
    estimadoAjustado,
    manoDeObra,
    desglose,
    reembolsoPorPersona,
    ganancia,
    porSocio: ganancia / 2,
    tienePagoReal,
    gananciaReal,
    porSocioReal: gananciaReal / 2,
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
      if (!p || p === "empresa" || p === "cliente") return;
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
  const totales = data.trabajos.reduce(
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
function Trabajos({ data, update }) {
  const [form, setForm] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [orden, setOrden] = useState("numero"); // "numero" = orden en que se agregaron, "abecedario" = A-Z
  const [materialesTrabajo, setMaterialesTrabajo] = useState(null);
  const [bitacoraTrabajo, setBitacoraTrabajo] = useState(null);

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
      });
    });
    setForm(null);
  };

  return (
    <div>
      <SectionTitle sub="Estimado menos materiales y mano de obra = ganancia, dividida 50/50">Trabajos</SectionTitle>

      {!form ? (
        <button className="btn-primary mb-4" onClick={() => setForm({ fecha: todayISO() })}>
          <Plus size={15} /> Nuevo trabajo
        </button>
      ) : (
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
          <div className="flex gap-2 pt-1">
            <button className="btn-primary" onClick={addTrabajo}><Check size={14} /> Guardar</button>
            <button className="text-sm text-[#7A7263] px-3" onClick={() => setForm(null)}>Cancelar</button>
          </div>
        </div>
      )}

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
        {[...data.trabajos]
          .sort((a, b) => {
            if (orden === "abecedario") {
              return (a.apodo || a.nombre || "").localeCompare(b.apodo || b.nombre || "", "es", { sensitivity: "base" });
            }
            return 0; // orden por número = mantiene el orden en que se agregaron
          })
          .map((t, idx) => {
          const c = calcTrabajo(t, data);
          const open = openId === t.id;
          return (
            <div key={t.id} className="card">
              <button className="w-full text-left p-4 flex justify-between items-center" onClick={() => setOpenId(open ? null : t.id)}>
                <div>
                  <div className="font-medium text-sm">
                    <span className="mono text-[#7A7263] mr-1.5">{t.numeroTrabajo ? `#${t.numeroTrabajo}` : `${idx + 1}.`}</span>
                    {t.apodo || t.nombre}
                  </div>
                  <div className="text-[12px] text-[#7A7263]">
                    {t.apodo ? `${t.nombre} · ` : ""}{t.cliente}{t.managerCliente ? ` (${t.managerCliente})` : ""}
                    {t.direccion ? ` · ${t.direccion}` : ""} · {fmtDate(t.fecha)}{t.diasEstimados ? ` · ${t.diasEstimados} días est.` : ""}
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
              </button>
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
                    <label className="text-[11px] text-[#7A7263] block mb-0.5">Estimado pagado (si pagaron menos del estimado, pon aquí lo que sí pagaron)</label>
                    <input
                      className="ledger-input text-xs"
                      type="number"
                      placeholder="Déjalo vacío si pagaron el estimado completo"
                      value={t.estimadoPagado ?? ""}
                      onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).estimadoPagado = e.target.value; })}
                    />
                  </div>
                  {c.tienePagoReal && (
                    <Row label="Ganancia real (según lo pagado)" value={money(c.gananciaReal)} bold accent={c.gananciaReal >= 0 ? GREEN : RED} />
                  )}

                  <div className="grid grid-cols-2 gap-2 pt-2">
                    {data.socios.map((s) => (
                      <div key={s.id} className="bg-[#F3EEE4] p-2 text-center">
                        <div className="text-[10px] text-[#7A7263] uppercase">{s.nombre}</div>
                        <div className="mono text-sm font-semibold">{money(c.tienePagoReal ? c.porSocioReal : c.porSocio)}</div>
                      </div>
                    ))}
                  </div>

                  <label className="text-[11px] text-[#7A7263] block mb-0.5 mt-3">Trabajo a realizar en ese lugar</label>
                  <div className="mb-3">
                    <NumberedListEditor
                      value={t.descripcionTrabajo || ""}
                      onChange={(val) => update((d) => { d.trabajos.find((x) => x.id === t.id).descripcionTrabajo = val; })}
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
                    className="ledger-input text-xs mb-2"
                    value={t.direccion || ""}
                    onChange={(e) => update((d) => { d.trabajos.find((x) => x.id === t.id).direccion = e.target.value; })}
                  />

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
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {materialesTrabajo && <MaterialesTrabajoModal trabajo={materialesTrabajo} data={data} onClose={() => setMaterialesTrabajo(null)} />}
      {bitacoraTrabajo && <BitacoraTrabajoModal trabajo={bitacoraTrabajo} data={data} onClose={() => setBitacoraTrabajo(null)} />}
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

      {data.trabajos.length > 0 && (
        <select className="ledger-input mb-3" value={filtroTrabajo} onChange={(e) => setFiltroTrabajo(e.target.value)}>
          <option value="">Todos los trabajos</option>
          {data.trabajos.map((t) => <option key={t.id} value={t.id}>{t.apodo || t.nombre}</option>)}
        </select>
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
                  <div className="flex-1 h-px" style={{ background: AMBER }} />
                </div>
              )}
            <div className="card p-4">
              <div className="flex justify-between items-start mb-1">
                <div className="font-medium text-sm">{trab?.apodo || trab?.nombre || "—"}</div>
                <div className="text-[11px] text-[#7A7263]">{fmtDate(b.fecha)}</div>
              </div>
              <p className="text-sm text-[#4A4238] mb-2">{b.descripcion}</p>

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
                            {data.socios.map((s) => <option key={s.id} value={s.id}>Pagado por {s.nombre} (a reembolsar)</option>)}
                          </select>
                          <select className="ledger-input text-xs" value={pagoEditForm.cuentaId || ""} onChange={(e) => setPagoEditForm({ ...pagoEditForm, cuentaId: e.target.value })}>
                            <option value="">Cuenta bancaria…</option>
                            {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                          </select>
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
                          {pago.reembolsado ? " · reembolsado" : ""}
                        </span>
                        <span className="flex items-center gap-2 shrink-0 ml-2">
                          <button
                            className="text-[#7A7263]"
                            title="Editar este pago"
                            onClick={() => {
                              setPagoEditForm({ empleadoId: pago.empleadoId, monto: pago.monto, pagadoPor: pago.pagadoPor || "empresa", cuentaId: pago.cuentaId || "" });
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
                    {data.socios.map((s) => <option key={s.id} value={s.id}>Pagado por {s.nombre} (a reembolsar)</option>)}
                  </select>
                  <select className="ledger-input text-xs" value={pagoForm.cuentaId || ""} onChange={(e) => setPagoForm({ ...pagoForm, cuentaId: e.target.value })}>
                    <option value="">Cuenta bancaria…</option>
                    {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
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
                {data.socios.map((s) => <option key={s.id} value={s.id}>Pagado por {s.nombre} (a reembolsar){data.rotacionNomina?.activa && s.id === socioEnTurno(data, payForm.fecha) ? " · turno del mes" : ""}</option>)}
              </select>
              <select className="ledger-input" value={payForm.cuentaId || ""} onChange={(e) => setPayForm({ ...payForm, cuentaId: e.target.value })}>
                <option value="">Cuenta bancaria…</option>
                {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
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
                    {data.socios.map((s) => <option key={s.id} value={s.id}>Pagado por {s.nombre} (a reembolsar)</option>)}
                  </select>
                  <select className="ledger-input text-xs" value={editForm.cuentaId || ""} onChange={(e) => setEditForm({ ...editForm, cuentaId: e.target.value })}>
                    <option value="">Cuenta bancaria…</option>
                    {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
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
                    <div className="text-[11px] text-[#7A7263]">{fmtDate(n.fecha)} · pagado por {pagadorNombre(data, n.pagadoPor)}{n.reembolsado ? " · reembolsado" : ""}</div>
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
                        setEditForm({ empleadoId: n.empleadoId, trabajoId: n.trabajoId || "", monto: n.monto, fecha: n.fecha, pagadoPor: n.pagadoPor || "empresa", cuentaId: n.cuentaId || "", estado: n.estado || "pagado" });
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
  const [ultimaFotoDevolucion, setUltimaFotoDevolucion] = useState(null);
  const [devolucionFotoSubiendo, setDevolucionFotoSubiendo] = useState(false);
  const [editandoMaterialId, setEditandoMaterialId] = useState(null);
  const [editMaterialForm, setEditMaterialForm] = useState({});
  // scan: { status: 'loading'|'review'|'error', foto, tienda, fecha, items:[], trabajoId, pagadoPor, empleadoPagadorId, cuentaId, errorMsg }

  // Agrupa los materiales por facturaId (los que vinieron juntos de un escaneo) — los sueltos quedan cada uno en su propio "grupo" de 1.
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
      ...Object.entries(porFactura).map(([facturaId, items]) => ({ facturaId, items, fechaOrden: items[0]?.fecha || "" })),
      ...sueltos.map((m) => ({ facturaId: null, items: [m], fechaOrden: m.fecha })),
    ];
    return grupos.sort((a, b) => (a.fechaOrden < b.fechaOrden ? 1 : -1));
  }, [data.materiales]);

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
        {gruposMateriales.map((grupo) => {
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
                    <div>{m.descripcion} <span className="text-[11px] text-[#7A7263]">{trab ? `· ${trab.apodo || trab.nombre}` : ""}</span></div>
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
                        <div className="flex gap-2">
                          <button
                            className="btn-primary text-xs"
                            onClick={() => {
                              update((d) => {
                                const item = d.materiales.find((x) => x.id === m.id);
                                item.trabajoId = editMaterialForm.trabajoId || "";
                                item.pagadoPor = editMaterialForm.pagadoPor === "empleado" ? `empleado:${editMaterialForm.empleadoPagadorId}` : (editMaterialForm.pagadoPor || "empresa");
                                item.cuentaId = editMaterialForm.cuentaId || "";
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
                          setEditMaterialForm({ trabajoId: m.trabajoId || "", pagadoPor: esEmpleado ? "empleado" : (m.pagadoPor || "empresa"), empleadoPagadorId: esEmpleado ? m.pagadoPor.slice("empleado:".length) : "", cuentaId: m.cuentaId || "" });
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
                <div className="text-[12px] text-[#7A7263]">
                  Factura · {items.length} artículos · {fmtDate(items[0].fecha)} {trab ? `· ${trab.apodo || trab.nombre}` : ""} · pagado por {pagadorNombre(data, items[0].pagadoPor)}
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
                            setEditMaterialForm({ trabajoId: it.trabajoId || "", pagadoPor: esEmpleado ? "empleado" : (it.pagadoPor || "empresa"), empleadoPagadorId: esEmpleado ? it.pagadoPor.slice("empleado:".length) : "", cuentaId: it.cuentaId || "" });
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
                          <div className="flex gap-2">
                            <button
                              className="btn-primary text-xs"
                              onClick={() => {
                                update((d) => {
                                  const item = d.materiales.find((x) => x.id === it.id);
                                  item.trabajoId = editMaterialForm.trabajoId || "";
                                  item.pagadoPor = editMaterialForm.pagadoPor === "empleado" ? `empleado:${editMaterialForm.empleadoPagadorId}` : (editMaterialForm.pagadoPor || "empresa");
                                  item.cuentaId = editMaterialForm.cuentaId || "";
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
                          items.forEach((it) => {
                            const item = d.materiales.find((x) => x.id === it.id);
                            const monto = devolucionSeleccion[it.id] !== undefined ? Number(devolucionSeleccion[it.id]) || 0 : 0;
                            item.montoDevuelto = monto;
                            if (devolucionFoto && !primeraConFoto && monto > 0) {
                              item.fotoDevolucion = devolucionFoto;
                              primeraConFoto = true;
                            } else if (monto === 0) {
                              item.fotoDevolucion = "";
                            }
                          });
                        });
                        if (devolucionFoto) setUltimaFotoDevolucion(devolucionFoto);
                        setDevolucionId(null);
                        setDevolucionFoto(null);
                        setDevolucionSeleccion({});
                      }}
                    >
                      <Check size={14} /> Guardar devolución
                    </button>
                    <button className="text-sm text-[#7A7263] px-2" onClick={() => { setDevolucionId(null); setDevolucionFoto(null); setDevolucionSeleccion({}); }}>Cancelar</button>
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
                  }}
                >
                  {totalDevuelto > 0 ? "Editar devolución de esta factura" : "¿Devolviste algún artículo de esta factura?"}
                </button>
              )}

              <div className="flex justify-between items-center pl-2 mt-1.5">
                <div className="text-[12px]">
                  <span className="text-[#7A7263]">Subtotal factura: {money(subtotalOriginal)}</span>
                  {totalDevuelto > 0 && <span className="text-[#7A7263]"> · Devuelto: {money(totalDevuelto)}</span>}
                </div>
                <span className="mono font-medium">{money(totalNeto)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Cuentas ---------------- */
function Cuentas({ data, update }) {
  const [form, setForm] = useState(null);
  const [transferForm, setTransferForm] = useState(null);
  const [incomeForm, setIncomeForm] = useState(null);
  const [cuentaModal, setCuentaModal] = useState(null);

  const addCuenta = () => {
    if (!form?.nombre) return;
    update((d) => d.cuentas.push({ id: uid(), nombre: form.nombre, banco: form.banco || "", saldoInicial: Number(form.saldoInicial || 0) }));
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
                  <div className="font-medium text-sm">{c.nombre}</div>
                  <div className="text-[11px] text-[#7A7263]">{c.banco}</div>
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
          <div className="flex gap-2">
            <button className="btn-primary" onClick={addCuenta}><Check size={14} /> Guardar</button>
            <button className="text-sm text-[#7A7263] px-2" onClick={() => setForm(null)}>Cancelar</button>
          </div>
        </div>
      )}

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
              <input className="ledger-input" type="date" value={incomeForm.fecha} onChange={(e) => setIncomeForm({ ...incomeForm, fecha: e.target.value })} />
              <select className="ledger-input" value={incomeForm.formaPago || "efectivo"} onChange={(e) => setIncomeForm({ ...incomeForm, formaPago: e.target.value })}>
                <option value="efectivo">Efectivo</option>
                <option value="cheque">Cheque</option>
                <option value="zelle">Zelle</option>
              </select>
              {incomeForm.formaPago === "cheque" && (
                <input className="ledger-input" placeholder="Número de cheque" value={incomeForm.numeroCheque || ""} onChange={(e) => setIncomeForm({ ...incomeForm, numeroCheque: e.target.value })} />
              )}
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
                return (
                  <div key={ing.id} className="flex justify-between items-center text-[11px] text-[#7A7263]">
                    <span>{fmtDate(ing.fecha)} · {cuenta?.nombre || "—"} · {formaPagoTexto(ing.formaPago, ing.numeroCheque)}</span>
                    <span className="flex items-center gap-1.5">
                      <span className="mono" style={{ color: GREEN }}>{money(ing.monto)}</span>
                      <button className="text-[#A13D2E]" onClick={() => update((d) => { d.ingresos = d.ingresos.filter((x) => x.id !== ing.id); })}>
                        <Trash2 size={11} />
                      </button>
                    </span>
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
                return (
                  <div key={tr.id} className="flex justify-between items-center text-[11px] text-[#7A7263]">
                    <span>{fmtDate(tr.fecha)} · {de?.nombre || "—"} → {a?.nombre || "—"} · {formaPagoTexto(tr.formaPago, tr.numeroCheque)}</span>
                    <span className="flex items-center gap-1.5">
                      <span className="mono">{money(tr.monto)}</span>
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

  const trabajosCerrados = [...data.trabajos]
    .filter((t) => t.estado === "cerrado")
    .sort((a, b) => {
      const ra = data.reportes.find((r) => r.trabajoId === a.id);
      const rb = data.reportes.find((r) => r.trabajoId === b.id);
      return (rb?.fechaCierre || "") < (ra?.fechaCierre || "") ? -1 : 1;
    });

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
                  <Row label="Ganancia total" value={money(c.ganancia)} bold accent={c.ganancia >= 0 ? GREEN : RED} />
                  <div className="grid grid-cols-2 gap-2 my-2">
                    {data.socios.map((s) => (
                      <div key={s.id} className="bg-[#F3EEE4] p-2 text-center">
                        <div className="text-[10px] text-[#7A7263] uppercase">{s.nombre}</div>
                        <div className="mono text-sm font-semibold">{money(c.porSocio)}</div>
                      </div>
                    ))}
                  </div>

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

      {reciboTrabajo && <ReciboModal trabajo={reciboTrabajo} data={data} onClose={() => setReciboTrabajo(null)} />}
    </div>
  );
}

/* ---------------- Modal configuración (socios + rotación) ---------------- */
function SociosModal({ data, update, onClose }) {
  const [names, setNames] = useState(data.socios.map((s) => s.nombre));
  const [empresaNombre, setEmpresaNombre] = useState(data.empresaNombre || "");
  const [rot, setRot] = useState(data.rotacionNomina || { activa: false, socioInicioId: "s1", mesInicio: todayISO().slice(0, 7) });

  const save = () => {
    update((d) => {
      d.socios.forEach((s, i) => (s.nombre = names[i] || s.nombre));
      d.empresaNombre = empresaNombre || d.empresaNombre;
      d.rotacionNomina = rot;
    });
    onClose();
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
      </div>
    </div>
  );
}

/* ---------------- Recibo grande, estilo tique de ferretería ---------------- */
/* ---------------- Hojas imprimibles sencillas (materiales/bitácora por trabajo, movimientos por cuenta) ---------------- */
function HojaImprimible({ titulo, subtitulo, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start sm:items-center justify-center p-3 overflow-y-auto">
      <div className="bg-white w-full max-w-md my-4">
        <div className="no-print flex justify-between items-center p-3 bg-[#1E2A38] sticky top-0 z-10">
          <button onClick={() => window.print()} className="btn-primary"><Printer size={15} /> Imprimir / PDF</button>
          <button onClick={onClose} className="text-white"><X size={20} /></button>
        </div>
        <div id="recibo-print" className="p-6" style={{ fontFamily: "'JetBrains Mono', monospace", color: "#111" }}>
          <div className="text-center mb-4">
            <Receipt size={28} className="mx-auto mb-1" />
            <div style={{ fontFamily: "'Special Elite', monospace" }} className="text-xl font-bold uppercase tracking-wide">{titulo}</div>
            {subtitulo && <div className="text-sm mt-1">{subtitulo}</div>}
          </div>
          <div className="recibo-linea" />
          {children}
        </div>
      </div>
    </div>
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
    ...ingresosC.map((i) => ({ fecha: i.fecha, tipo: "Ingreso de cliente", detalle: i.concepto, monto: i.monto, signo: 1, formaPago: formaPagoTextoStandalone(i.formaPago, i.numeroCheque) })),
    ...transfEntrada.map((t) => ({ fecha: t.fecha, tipo: "Transferencia recibida", detalle: `de ${data.cuentas.find((c) => c.id === t.deCuentaId)?.nombre || "—"}`, monto: t.monto, signo: 1, formaPago: formaPagoTextoStandalone(t.formaPago, t.numeroCheque) })),
    ...transfSalida.map((t) => ({ fecha: t.fecha, tipo: "Transferencia enviada", detalle: `a ${data.cuentas.find((c) => c.id === t.aCuentaId)?.nombre || "—"}`, monto: t.monto, signo: -1, formaPago: formaPagoTextoStandalone(t.formaPago, t.numeroCheque) })),
    ...materialesC.map((m) => ({ fecha: m.fecha, tipo: "Material", detalle: m.descripcion, monto: materialNeto(m), signo: -1, formaPago: "" })),
    ...nominaC.map((n) => ({ fecha: n.fecha, tipo: "Nómina", detalle: data.empleados.find((e) => e.id === n.empleadoId)?.nombre || "—", monto: n.monto, signo: -1, formaPago: "" })),
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

function ReciboModal({ trabajo, data, onClose }) {
  const c = calcTrabajo(trabajo, data);
  const reporte = data.reportes.find((r) => r.trabajoId === trabajo.id);
  const materialesT = data.materiales.filter((m) => m.trabajoId === trabajo.id);
  const nominaT = data.nomina.filter((n) => n.trabajoId === trabajo.id);
  const clienteInfo = data.clientes.find((cl) => cl.nombre === trabajo.cliente);

  // Reembolsos pendientes de ESTE trabajo únicamente (socios o trabajadores que pagaron de su bolsa)
  const reembolsosTrabajo = {};
  const acumular = (item, tipo) => {
    const p = item.pagadoPor;
    if (!p || p === "empresa" || p === "cliente" || item.reembolsado) return;
    const nombre = pagadorNombre(data, p);
    const monto = tipo === "Material" ? materialNeto(item) : Number(item.monto);
    if (!reembolsosTrabajo[p]) reembolsosTrabajo[p] = { nombre, materiales: 0, nomina: 0, total: 0 };
    if (tipo === "Material") reembolsosTrabajo[p].materiales += monto;
    else reembolsosTrabajo[p].nomina += monto;
    reembolsosTrabajo[p].total += monto;
  };
  materialesT.forEach((m) => acumular(m, "Material"));
  nominaT.forEach((n) => acumular(n, "Nómina"));
  const listaReembolsos = Object.values(reembolsosTrabajo);

  // Primero se reembolsa a quien puso dinero de su bolsa, y lo que resta se divide 50/50 entre los socios.
  // Si ya se confirmó cuánto pagó realmente el cliente (estimadoPagado), se usa ese número en vez del estimado completo.
  const gananciaParaReparto = c.tienePagoReal ? c.gananciaReal : c.ganancia;
  const totalReembolsosTrabajo = listaReembolsos.reduce((s, r) => s + r.total, 0);
  const restoARepartir = gananciaParaReparto - totalReembolsosTrabajo;
  const mitadResto = restoARepartir / 2;
  const reembolsoDeSocio = (socioId) => reembolsosTrabajo[socioId]?.total || 0;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start sm:items-center justify-center p-3 overflow-y-auto">
      <div className="bg-white w-full max-w-md my-4">
        <div className="no-print flex justify-between items-center p-3 bg-[#1E2A38] sticky top-0 z-10">
          <button onClick={() => window.print()} className="btn-primary"><Printer size={15} /> Imprimir / PDF</button>
          <button onClick={onClose} className="text-white"><X size={20} /></button>
        </div>

        <div id="recibo-print" className="p-6" style={{ fontFamily: "'JetBrains Mono', monospace", color: "#111" }}>
          <div className="text-center mb-4">
            <Receipt size={30} className="mx-auto mb-1" />
            <div style={{ fontFamily: "'Special Elite', monospace" }} className="text-2xl font-bold uppercase tracking-wide">
              Reporte de Cierre
            </div>
            <div className="text-xs mt-1">{reporte?.fechaCierre ? fmtDate(reporte.fechaCierre) : ""}</div>
          </div>

          <div className="recibo-linea" />

          <div className="text-center mb-2">
            <div className="text-xl font-bold uppercase">{trabajo.nombre}</div>
            {trabajo.numeroTrabajo && (
              <div className="text-sm mt-0.5" style={{ color: "#666" }}>Trabajo #{trabajo.numeroTrabajo}</div>
            )}
          </div>

          <div className="recibo-linea" />

          <div className="text-sm font-bold uppercase mb-2">Cliente</div>
          <div className="text-lg font-bold mb-1.5">{trabajo.cliente || "—"}</div>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", rowGap: "3px", columnGap: "10px" }}>
            {trabajo.managerCliente && (
              <>
                <span className="text-xs uppercase" style={{ color: "#888" }}>Contacto</span>
                <span className="text-sm">{trabajo.managerCliente}</span>
              </>
            )}
            {clienteInfo?.telefono && (
              <>
                <span className="text-xs uppercase" style={{ color: "#888" }}>Teléfono</span>
                <span className="text-sm">{clienteInfo.telefono}</span>
              </>
            )}
            {clienteInfo?.correo && (
              <>
                <span className="text-xs uppercase" style={{ color: "#888" }}>Correo</span>
                <span className="text-sm">{clienteInfo.correo}</span>
              </>
            )}
            {trabajo.direccion && (
              <>
                <span className="text-xs uppercase" style={{ color: "#888" }}>Dirección</span>
                <span className="text-sm">{trabajo.direccion}</span>
              </>
            )}
          </div>

          <div className="recibo-linea" />

          <div className="text-sm font-bold uppercase mb-2">Información del trabajo</div>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", rowGap: "5px", columnGap: "10px" }}>
            {trabajo.descripcionTrabajo &&
              trabajo.descripcionTrabajo.split("\n").filter((linea) => linea.trim()).map((linea, i) => (
                <React.Fragment key={i}>
                  <span className="text-xs uppercase" style={{ color: "#888" }}>Trabajo realizado</span>
                  <span className="text-sm">{linea}</span>
                </React.Fragment>
              ))}
            {trabajo.fecha && (
              <>
                <span className="text-xs uppercase" style={{ color: "#888" }}>Inicio</span>
                <span className="text-sm">{fmtDate(trabajo.fecha)}</span>
              </>
            )}
            {trabajo.fechaTerminado && (
              <>
                <span className="text-xs uppercase" style={{ color: "#888" }}>Finalizado</span>
                <span className="text-sm">{fmtDate(trabajo.fechaTerminado)}</span>
              </>
            )}
            {trabajo.fecha && trabajo.fechaTerminado && (
              <>
                <span className="text-xs uppercase" style={{ color: "#888" }}>Duración</span>
                <span className="text-sm">
                  {Math.max(1, Math.round((new Date(trabajo.fechaTerminado) - new Date(trabajo.fecha)) / 86400000) + 1)} día(s)
                </span>
              </>
            )}
            {trabajo.diasEstimados && (
              <>
                <span className="text-xs uppercase" style={{ color: "#888" }}>Estimado de tiempo</span>
                <span className="text-sm">{trabajo.diasEstimados} día(s)</span>
              </>
            )}
          </div>

          <div className="recibo-linea" />

          <div className="flex justify-between text-base font-bold py-1">
            <span>SUBTOTAL MATERIALES</span>
            <span>{money(c.materiales)}</span>
          </div>

          <div className="recibo-linea" />

          <div className="text-sm font-bold uppercase mb-2">Mano de obra</div>
          {nominaT.length === 0 && <div className="text-sm mb-2">— sin registros —</div>}
          {nominaT.map((n) => (
            <div key={n.id} className="flex justify-between text-base py-1">
              <span className="pr-2">{data.empleados.find((e) => e.id === n.empleadoId)?.nombre || "—"}</span>
              <span className="whitespace-nowrap font-semibold">{money(n.monto)}</span>
            </div>
          ))}
          <div className="flex justify-between text-base font-bold pt-2 border-t border-black mt-1">
            <span>SUBTOTAL MANO DE OBRA</span>
            <span>{money(c.manoDeObra)}</span>
          </div>

          <div className="recibo-linea" />

          <div className="flex justify-between text-lg font-bold py-1">
            <span>ESTIMADO</span>
            <span>{money(Number(trabajo.estimado))}</span>
          </div>
          {c.tienePagoReal && (
            <div className="flex justify-between text-lg font-bold py-1" style={{ color: AMBER }}>
              <span>ESTIMADO PAGADO (lo que sí pagó el cliente)</span>
              <span>{money(Number(trabajo.estimadoPagado))}</span>
            </div>
          )}
          <div className="flex justify-between text-2xl font-bold py-2" style={{ color: gananciaParaReparto >= 0 ? "#1E6B3E" : "#A13D2E" }}>
            <span>GANANCIA {c.tienePagoReal ? "REAL" : "BRUTA"}</span>
            <span>{money(gananciaParaReparto)}</span>
          </div>
          <div className="text-[11px] mb-1" style={{ color: "#888" }}>
            {c.tienePagoReal ? "Ya considera lo que realmente pagó el cliente. " : ""}Antes de restar los reembolsos pendientes — el reparto real está abajo.
          </div>

          <div className="recibo-linea" />

          <div className="text-sm font-bold uppercase mb-2">Reparto 50 / 50</div>

          {totalReembolsosTrabajo > 0 && (
            <div className="bg-gray-50 px-3 py-2 mb-3" style={{ background: "#F5F3EE" }}>
              <div className="flex justify-between text-xs py-0.5" style={{ color: "#555" }}>
                <span>Ganancia del trabajo</span>
                <span>{money(c.ganancia)}</span>
              </div>
              <div className="flex justify-between text-xs py-0.5" style={{ color: "#A13D2E" }}>
                <span>Reembolsos pendientes</span>
                <span>-{money(totalReembolsosTrabajo)}</span>
              </div>
              <div className="flex justify-between text-sm font-bold py-1 mt-1" style={{ borderTop: "1px solid #999" }}>
                <span>Resta a repartir</span>
                <span>{money(restoARepartir)}</span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            {data.socios.map((s) => (
              <div key={s.id} className="text-center py-2 px-1" style={{ background: "#F5F3EE" }}>
                <div className="text-xs uppercase tracking-wide" style={{ color: "#777" }}>{s.nombre}</div>
                <div className="text-xl font-bold mt-0.5">{money(mitadResto)}</div>
                <div className="text-[10px] mt-0.5" style={{ color: "#888" }}>ganancia de este trabajo</div>
              </div>
            ))}
          </div>

          {data.socios.some((s) => reembolsoDeSocio(s.id) > 0) && (
            <div className="grid grid-cols-2 gap-2 mt-2">
              {data.socios.map((s) => {
                const reembolsoPropio = reembolsoDeSocio(s.id);
                if (reembolsoPropio <= 0) return <div key={s.id} />;
                return (
                  <div key={s.id} className="text-center py-2 px-1" style={{ background: "#FBF3E3", border: "1px solid #E8D9A8" }}>
                    <div className="text-xs uppercase tracking-wide" style={{ color: "#8A6416" }}>Reembolso a {s.nombre}</div>
                    <div className="text-lg font-bold mt-0.5" style={{ color: "#8A6416" }}>{money(reembolsoPropio)}</div>
                    <div className="text-[10px] mt-0.5" style={{ color: "#8A6416" }}>dinero que se le debe, aparte de su ganancia</div>
                  </div>
                );
              })}
            </div>
          )}

          {listaReembolsos.length > 0 && (
            <>
              <div className="recibo-linea" />
              <div className="text-sm font-bold uppercase mb-2">Reembolsos pendientes de este trabajo</div>
              {listaReembolsos.map((r) => (
                <div key={r.nombre} className="mb-2">
                  <div className="flex justify-between text-base font-bold">
                    <span>{r.nombre}</span>
                    <span className="whitespace-nowrap" style={{ color: "#A13D2E" }}>{money(r.total)}</span>
                  </div>
                  {r.materiales > 0 && (
                    <div className="flex justify-between text-sm pl-3" style={{ color: "#555" }}>
                      <span>· Materiales</span>
                      <span>{money(r.materiales)}</span>
                    </div>
                  )}
                  {r.nomina > 0 && (
                    <div className="flex justify-between text-sm pl-3" style={{ color: "#555" }}>
                      <span>· Mano de obra</span>
                      <span>{money(r.nomina)}</span>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}

          {reporte?.notas && (
            <>
              <div className="recibo-linea" />
              <div className="text-sm font-bold uppercase mb-1">Notas</div>
              <div className="text-sm whitespace-pre-wrap">{reporte.notas}</div>
            </>
          )}

          <div className="recibo-linea" />
          <div className="text-center text-[11px] tracking-widest uppercase mt-3">*** Fin del reporte ***</div>
        </div>
      </div>
    </div>
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
