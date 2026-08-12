import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  LayoutDashboard, Briefcase, Users, Package, Landmark, ArrowLeftRight,
  ClipboardList, Plus, X, Check, Trash2, Loader2, Settings, Camera, ImageOff, Printer, Receipt, Sparkles, PenLine, Download, ShieldAlert, CalendarDays, Tag, Building2, Phone, Mail, Hash
} from "lucide-react";
import { db } from "./firebase";
import { doc, onSnapshot, setDoc } from "firebase/firestore";

const DOC_REF_PATH = ["app", "data"]; // colección "app", documento "data"

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
function compressImage(file, maxWidth = 1000, quality = 0.6) {
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

// Le pide a la IA que lea la foto de la factura y devuelva los renglones estructurados
// Le pide a la IA que lea la foto de la factura y devuelva los renglones estructurados
// (la llamada real a Anthropic pasa por /api/scan-invoice para no exponer la llave en el navegador)
async function extraerFacturaConIA(dataUrl) {
  const base64 = dataUrl.split(",")[1];
  const response = await fetch("/api/scan-invoice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64 }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(errText || "Error del servidor al leer la factura");
  }
  const parsed = await response.json();
  if (!Array.isArray(parsed.items)) throw new Error("Formato inesperado");
  return parsed;
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

function useLedgerData() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    const ref = doc(db, ...DOC_REF_PATH);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          setData({ ...emptyData(), ...snap.data() });
        } else {
          setData(emptyData());
        }
        setStatus("ready");
      },
      (err) => {
        console.error(err);
        setStatus("error");
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
      console.error(e);
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
function calcTrabajo(t, data) {
  // Los materiales que pagó directamente el cliente no cuentan como gasto nuestro
  const materialesPropios = data.materiales.filter((m) => m.trabajoId === t.id && m.pagadoPor !== "cliente");
  const materialesCliente = data.materiales.filter((m) => m.trabajoId === t.id && m.pagadoPor === "cliente");
  const materiales = materialesPropios.reduce((s, m) => s + Number(m.monto), 0);
  const materialesAportadosPorCliente = materialesCliente.reduce((s, m) => s + Number(m.monto), 0);
  const manoDeObra = data.nomina.filter((n) => n.trabajoId === t.id).reduce((s, n) => s + Number(n.monto), 0);
  const ganancia = Number(t.estimado || 0) - materiales - manoDeObra;
  // Si ya se sabe cuánto pagó realmente el cliente (a veces es menos del estimado), la ganancia real usa ese monto
  const tienePagoReal = t.estimadoPagado !== undefined && t.estimadoPagado !== null && t.estimadoPagado !== "";
  const gananciaReal = tienePagoReal ? Number(t.estimadoPagado || 0) - materiales - manoDeObra : ganancia;
  return {
    materiales,
    materialesAportadosPorCliente,
    manoDeObra,
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
  const consider = (list, tipoItem) =>
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
      if (item.reembolsado) bucket.pagado += Number(item.monto);
      else {
        bucket.pendiente += Number(item.monto);
        bucket.items.push({ ...item, tipo: tipoItem });
      }
    });
  consider(data.materiales, "Material");
  consider(data.nomina, "Nómina");
  return Object.values(buckets);
}

function calcCuentaSaldo(cuenta, data) {
  const ingresos = data.ingresos.filter((i) => i.cuentaId === cuenta.id).reduce((s, i) => s + Number(i.monto), 0);
  const gastosMat = data.materiales
    .filter((m) => m.cuentaId === cuenta.id)
    .reduce((s, m) => s + Number(m.monto), 0);
  const gastosNom = data.nomina
    .filter((n) => n.cuentaId === cuenta.id)
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
                  <Row label="Estimado" value={money(Number(t.estimado))} />
                  <Row label="Materiales gastados" value={money(c.materiales)} accent={RED} />
                  <Row label="Mano de obra / nómina" value={money(c.manoDeObra)} accent={RED} />
                  {c.materialesAportadosPorCliente > 0 && (
                    <Row label="Materiales que puso el cliente (no afecta)" value={money(c.materialesAportadosPorCliente)} />
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
                </div>
              )}
            </div>
          );
        })}
      </div>
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

function Bitacora({ data, update }) {
  const [form, setForm] = useState(null);
  const [nuevoParticipante, setNuevoParticipante] = useState("");
  const [filtroTrabajo, setFiltroTrabajo] = useState("");
  const [editandoId, setEditandoId] = useState(null);
  const [extraTemp, setExtraTemp] = useState("");

  const addEntrada = () => {
    if (!form?.trabajoId || !form?.descripcion) return;

    const nominaId = uid();
    const hayPago = form.empleadoPagoId && form.montoNota;

    update((d) => {
      d.bitacora.push({
        id: uid(),
        trabajoId: form.trabajoId,
        fecha: form.fecha || todayISO(),
        descripcion: form.descripcion,
        empleadoIds: form.empleadoIds || [],
        socioIds: form.socioIds || [],
        extras: form.extras || [],
        estado: form.estado || "pendiente",
        nominaId: hayPago ? nominaId : "",
      });

      if (hayPago) {
        d.nomina.push({
          id: nominaId,
          empleadoId: form.empleadoPagoId,
          trabajoId: form.trabajoId,
          fecha: form.fecha || todayISO(),
          monto: Number(form.montoNota),
          pagadoPor: form.pagadoPorNota || "empresa",
          cuentaId: form.cuentaIdNota || "",
          reembolsado: false,
        });
      }
    });
    setForm(null);
    setNuevoParticipante("");
  };

  const toggleEmpleado = (empId) => {
    setForm((f) => {
      const set = new Set(f.empleadoIds || []);
      set.has(empId) ? set.delete(empId) : set.add(empId);
      return { ...f, empleadoIds: Array.from(set) };
    });
  };

  const toggleSocio = (socioId) => {
    setForm((f) => {
      const set = new Set(f.socioIds || []);
      set.has(socioId) ? set.delete(socioId) : set.add(socioId);
      return { ...f, socioIds: Array.from(set) };
    });
  };

  const addExtra = () => {
    const nombre = nuevoParticipante.trim();
    if (!nombre) return;
    setForm((f) => ({ ...f, extras: [...(f.extras || []), nombre] }));
    setNuevoParticipante("");
  };

  const removeExtra = (nombre) => {
    setForm((f) => ({ ...f, extras: (f.extras || []).filter((n) => n !== nombre) }));
  };

  const toggleEstado = (id) => {
    update((d) => {
      const entrada = d.bitacora.find((x) => x.id === id);
      entrada.estado = entrada.estado === "completado" ? "pendiente" : "completado";
    });
  };

  const toggleEmpleadoGuardado = (bitId, empId) => {
    update((d) => {
      const entrada = d.bitacora.find((x) => x.id === bitId);
      const set = new Set(entrada.empleadoIds || []);
      set.has(empId) ? set.delete(empId) : set.add(empId);
      entrada.empleadoIds = Array.from(set);
    });
  };

  const toggleSocioGuardado = (bitId, socioId) => {
    update((d) => {
      const entrada = d.bitacora.find((x) => x.id === bitId);
      const set = new Set(entrada.socioIds || []);
      set.has(socioId) ? set.delete(socioId) : set.add(socioId);
      entrada.socioIds = Array.from(set);
    });
  };

  const addExtraGuardado = (bitId, nombre) => {
    if (!nombre.trim()) return;
    update((d) => {
      const entrada = d.bitacora.find((x) => x.id === bitId);
      entrada.extras = [...(entrada.extras || []), nombre.trim()];
    });
  };

  const removeExtraGuardado = (bitId, nombre) => {
    update((d) => {
      const entrada = d.bitacora.find((x) => x.id === bitId);
      entrada.extras = (entrada.extras || []).filter((n) => n !== nombre);
    });
  };

  const entradas = [...data.bitacora]
    .filter((b) => !filtroTrabajo || b.trabajoId === filtroTrabajo)
    .sort((a, b) => (a.fecha < b.fecha ? 1 : -1));

  return (
    <div>
      <SectionTitle sub="Qué se hizo cada día en cada trabajo, quién participó, y si ya se le pagó">Actividad diaria</SectionTitle>

      {data.trabajos.length === 0 ? (
        <div className="card p-4 mb-4">
          <p className="text-[13px] text-[#4A4238]">
            Antes de registrar actividad, agrega al menos un trabajo en la pestaña <b>Trabajos</b> — cada actividad tiene que estar ligada a uno.
          </p>
        </div>
      ) : !form ? (
        <button className="btn-primary mb-4" onClick={() => setForm({ fecha: todayISO(), empleadoIds: [], socioIds: [], extras: [], estado: "pendiente" })}>
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

          {data.socios.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-1">
              {data.socios.map((s) => {
                const selected = (form.socioIds || []).includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggleSocio(s.id)}
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
                const selected = (form.empleadoIds || []).includes(emp.id);
                return (
                  <button
                    key={emp.id}
                    type="button"
                    onClick={() => toggleEmpleado(emp.id)}
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

          {(form.extras || []).length > 0 && (
            <div className="flex flex-wrap gap-2 mb-1">
              {form.extras.map((nombre) => (
                <span key={nombre} className="text-xs px-2.5 py-1.5 border flex items-center gap-1" style={{ borderColor: AMBER, background: "#F3EEE4", color: "#1E2A38" }}>
                  {nombre}
                  <button type="button" onClick={() => removeExtra(nombre)}><X size={12} /></button>
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
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addExtra(); } }}
            />
            <button type="button" className="text-sm px-3 border" style={{ borderColor: LINE }} onClick={addExtra}>
              + Agregar
            </button>
          </div>

          <div className="stamp text-[12px] text-[#7A7263] mt-2 mb-1">ESTADO DEL PAGO</div>
          <div className="flex gap-2 mb-2">
            <button
              type="button"
              onClick={() => setForm({ ...form, estado: "pendiente" })}
              className="text-xs px-3 py-1.5 border font-medium"
              style={{
                borderColor: form.estado === "pendiente" ? "#A13D2E" : LINE,
                background: form.estado === "pendiente" ? "#F7DEDA" : "#fff",
                color: form.estado === "pendiente" ? "#A13D2E" : "#7A7263",
              }}
            >
              Pendiente
            </button>
            <button
              type="button"
              onClick={() => setForm({ ...form, estado: "completado" })}
              className="text-xs px-3 py-1.5 border font-medium"
              style={{
                borderColor: form.estado === "completado" ? GREEN : LINE,
                background: form.estado === "completado" ? "#DDEEDF" : "#fff",
                color: form.estado === "completado" ? GREEN : "#7A7263",
              }}
            >
              Completado
            </button>
          </div>

          <div className="stamp text-[12px] text-[#7A7263] mt-2 mb-1">REGISTRAR PAGO DE NÓMINA (esto sí cuenta en Reembolsos y Cuentas)</div>
          <select
            className="ledger-input mb-2"
            value={form.empleadoPagoId || ""}
            onChange={(e) => setForm({ ...form, empleadoPagoId: e.target.value })}
          >
            <option value="">¿A quién se le pagó? (opcional)</option>
            {data.empleados.map((emp) => <option key={emp.id} value={emp.id}>{emp.nombre}</option>)}
          </select>
          {form.empleadoPagoId && (
            <div className="space-y-2 mb-2">
              <input
                className="ledger-input"
                type="number"
                placeholder="Monto"
                value={form.montoNota || ""}
                onChange={(e) => setForm({ ...form, montoNota: e.target.value })}
              />
              <select
                className="ledger-input"
                value={form.pagadoPorNota || "empresa"}
                onChange={(e) => setForm({ ...form, pagadoPorNota: e.target.value })}
              >
                <option value="empresa">Pagado desde cuenta de {data.empresaNombre}</option>
                {data.socios.map((s) => <option key={s.id} value={s.id}>Pagado por {s.nombre} (a reembolsar)</option>)}
              </select>
              <select
                className="ledger-input"
                value={form.cuentaIdNota || ""}
                onChange={(e) => setForm({ ...form, cuentaIdNota: e.target.value })}
              >
                <option value="">Cuenta bancaria…</option>
                {data.cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </div>
          )}

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
        {entradas.map((b) => {
          const trab = data.trabajos.find((t) => t.id === b.trabajoId);
          const empleadosDelDia = (b.empleadoIds || []).map((id) => data.empleados.find((e) => e.id === id)?.nombre).filter(Boolean);
          const sociosDelDia = (b.socioIds || []).map((id) => data.socios.find((s) => s.id === id)?.nombre).filter(Boolean);
          const todosParticipantes = [...sociosDelDia, ...empleadosDelDia, ...(b.extras || [])];
          const completado = b.estado === "completado";
          return (
            <div key={b.id} className="card p-4">
              <div className="flex justify-between items-start mb-1">
                <div className="font-medium text-sm">{trab?.apodo || trab?.nombre || "—"}</div>
                <div className="text-[11px] text-[#7A7263]">{fmtDate(b.fecha)}</div>
              </div>
              <p className="text-sm text-[#4A4238] mb-2">{b.descripcion}</p>

              {editandoId === b.id ? (
                <div className="border p-2 mb-2" style={{ borderColor: AMBER, background: "#FBF8F2" }}>
                  <div className="text-[10px] text-[#7A7263] uppercase mb-1">Editar participantes</div>
                  {data.socios.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {data.socios.map((s) => {
                        const selected = (b.socioIds || []).includes(s.id);
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => toggleSocioGuardado(b.id, s.id)}
                            className="text-[11px] px-2 py-1 border"
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
                  {data.empleados.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {data.empleados.map((emp) => {
                        const selected = (b.empleadoIds || []).includes(emp.id);
                        return (
                          <button
                            key={emp.id}
                            type="button"
                            onClick={() => toggleEmpleadoGuardado(b.id, emp.id)}
                            className="text-[11px] px-2 py-1 border"
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
                  {(b.extras || []).length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {b.extras.map((nombre) => (
                        <span key={nombre} className="text-[11px] px-2 py-1 border flex items-center gap-1" style={{ borderColor: AMBER, background: "#F3EEE4" }}>
                          {nombre}
                          <button type="button" onClick={() => removeExtraGuardado(b.id, nombre)}><X size={11} /></button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-1.5 mb-2">
                    <input
                      className="ledger-input flex-1 text-xs"
                      placeholder="Agregar otra persona"
                      value={extraTemp}
                      onChange={(e) => setExtraTemp(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addExtraGuardado(b.id, extraTemp); setExtraTemp(""); } }}
                    />
                    <button
                      type="button"
                      className="text-xs px-2 border"
                      style={{ borderColor: LINE }}
                      onClick={() => { addExtraGuardado(b.id, extraTemp); setExtraTemp(""); }}
                    >
                      + Agregar
                    </button>
                  </div>
                  <button className="text-[11px] text-[#7A7263] underline" onClick={() => setEditandoId(null)}>Listo</button>
                </div>
              ) : (
                todosParticipantes.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setEditandoId(b.id)}
                    className="flex flex-wrap gap-1 mb-2 text-left"
                  >
                    {todosParticipantes.map((nombre, i) => (
                      <span key={nombre + i} className="text-[11px] px-2 py-0.5 bg-[#F3EEE4] border" style={{ borderColor: LINE }}>{nombre}</span>
                    ))}
                    <span className="text-[11px] text-[#7A7263] underline self-center">editar</span>
                  </button>
                )
              )}
              {editandoId !== b.id && todosParticipantes.length === 0 && (
                <button className="text-[11px] text-[#7A7263] underline mb-2" onClick={() => setEditandoId(b.id)}>
                  + agregar participantes
                </button>
              )}
              {b.nominaId && (() => {
                const pago = data.nomina.find((n) => n.id === b.nominaId);
                if (!pago) return null;
                const empleado = data.empleados.find((e) => e.id === pago.empleadoId);
                return (
                  <div className="text-[11px] text-[#7A7263] mb-2">
                    Pago: <b>{money(pago.monto)}</b> a {empleado?.nombre || "—"} · pagado por {pagadorNombre(data, pago.pagadoPor)}
                    {pago.reembolsado ? " · reembolsado" : ""}
                  </div>
                );
              })()}
              <div className="flex justify-between items-center">
                <button
                  onClick={() => toggleEstado(b.id)}
                  className="text-[11px] font-medium px-2.5 py-1 border"
                  style={{
                    borderColor: completado ? GREEN : "#A13D2E",
                    background: completado ? "#DDEEDF" : "#F7DEDA",
                    color: completado ? GREEN : "#A13D2E",
                  }}
                >
                  {completado ? "Completado" : "Pendiente"}
                </button>
                <button
                  className="text-[11px] text-[#A13D2E]"
                  onClick={() => update((d) => { d.bitacora = d.bitacora.filter((x) => x.id !== b.id); })}
                >
                  Eliminar
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Nomina({ data, update }) {
  const [empForm, setEmpForm] = useState(null);
  const [payForm, setPayForm] = useState(null);
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
          return (
            <div key={n.id} className="flex justify-between items-center py-1.5 text-sm border-b last:border-0" style={{ borderColor: LINE }}>
              <div>
                <div>{emp?.nombre || "—"} <span className="text-[11px] text-[#7A7263]">{trab ? `· ${trab.apodo || trab.nombre}` : ""}</span></div>
                <div className="text-[11px] text-[#7A7263]">{fmtDate(n.fecha)} · pagado por {pagadorNombre(data, n.pagadoPor)}{n.reembolsado ? " · reembolsado" : ""}</div>
              </div>
              <span className="mono">{money(n.monto)}</span>
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
  // scan: { status: 'loading'|'review'|'error', foto, tienda, fecha, items:[], trabajoId, pagadoPor, empleadoPagadorId, cuentaId, errorMsg }

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
        foto: form.foto || null,
      })
    );
    setForm(null);
  };

  const handleFoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const dataUrl = await compressImage(file);
      setForm((f) => ({ ...f, foto: dataUrl }));
    } catch {
      // si falla la compresión simplemente no se adjunta
    }
    setUploading(false);
  };

  const handleEscaneo = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScan({ status: "loading" });
    try {
      const foto = await compressImage(file, 1400, 0.72);
      const parsed = await extraerFacturaConIA(foto);
      setScan({
        status: "review",
        foto,
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
  };

  const guardarEscaneo = () => {
    if (!scan || scan.items.length === 0) return;
    const pagadoPorFinal = scan.pagadoPor === "empleado" ? `empleado:${scan.empleadoPagadorId}` : scan.pagadoPor;
    update((d) => {
      scan.items.forEach((it) => {
        const etiqueta = it.numeroProducto ? `${it.descripcion} (#${it.numeroProducto})` : it.descripcion;
        d.materiales.push({
          id: uid(),
          trabajoId: scan.trabajoId || "",
          descripcion: it.cantidad && it.cantidad !== 1 ? `${etiqueta} x${it.cantidad}` : etiqueta,
          monto: Number(it.importe) || 0,
          fecha: scan.fecha || todayISO(),
          pagadoPor: pagadoPorFinal,
          cuentaId: scan.cuentaId || "",
          reembolsado: false,
          foto: scan.foto,
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
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handleEscaneo} />
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
            {scan.foto && <img src={scan.foto} alt="Factura escaneada" className="w-16 h-16 object-cover border shrink-0" style={{ borderColor: LINE }} />}
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
            <span className="text-[#4A4238]">{uploading ? "Procesando foto…" : form.foto ? "Foto adjuntada · cambiar" : "Adjuntar foto de la factura"}</span>
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFoto} />
          </label>
          {form.foto && (
            <img src={form.foto} alt="Vista previa de la factura" className="h-24 w-auto border" style={{ borderColor: LINE }} />
          )}

          <div className="flex gap-2">
            <button className="btn-primary" onClick={addMaterial} disabled={uploading}><Check size={14} /> Guardar</button>
            <button className="text-sm text-[#7A7263] px-2" onClick={() => setForm(null)}>Cancelar</button>
          </div>
        </div>
      )}

      <div className="card p-4">
        {data.materiales.length === 0 && <Empty text="Sin materiales registrados." />}
        {[...data.materiales].sort((a, b) => (a.fecha < b.fecha ? 1 : -1)).map((m) => {
          const trab = data.trabajos.find((t) => t.id === m.trabajoId);
          return (
            <div key={m.id} className="flex justify-between items-center py-1.5 text-sm border-b last:border-0" style={{ borderColor: LINE }}>
              <div className="flex items-center gap-2">
                {m.foto ? (
                  <img
                    src={m.foto}
                    alt="Factura"
                    className="w-9 h-9 object-cover border cursor-pointer shrink-0"
                    style={{ borderColor: LINE }}
                    onClick={() => onViewPhoto?.(m.foto)}
                  />
                ) : (
                  <div className="w-9 h-9 flex items-center justify-center border shrink-0 text-[#C9C1B0]" style={{ borderColor: LINE }}>
                    <ImageOff size={14} />
                  </div>
                )}
                <div>
                  <div>{m.descripcion} <span className="text-[11px] text-[#7A7263]">{trab ? `· ${trab.apodo || trab.nombre}` : ""}</span></div>
                  <div className="text-[11px] text-[#7A7263]">
                    {fmtDate(m.fecha)} · pagado por {pagadorNombre(data, m.pagadoPor)}
                    {m.reembolsado ? " · reembolsado" : ""}
                    {m.pagadoPor === "cliente" ? " · no afecta ganancia" : ""}
                  </div>
                </div>
              </div>
              <span className="mono">{money(m.monto)}</span>
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
      })
    );
    setTransferForm(null);
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
            <button className="btn-primary" onClick={() => setIncomeForm({ fecha: todayISO() })} disabled={data.cuentas.length === 0}><Plus size={14} /> Ingreso</button>
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
              <div className="flex gap-2">
                <button className="btn-primary" onClick={addIngreso}><Check size={14} /> Guardar</button>
                <button className="text-sm text-[#7A7263] px-2" onClick={() => setIncomeForm(null)}>Cancelar</button>
              </div>
            </div>
          )}
        </div>

        <div className="card p-4">
          <div className="stamp text-[13px] text-[#7A7263] mb-3">TRANSFERENCIA ENTRE CUENTAS</div>
          {!transferForm ? (
            <button className="btn-primary" onClick={() => setTransferForm({ fecha: todayISO() })} disabled={data.cuentas.length < 2}><Plus size={14} /> Transferencia</button>
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
              <div className="flex gap-2">
                <button className="btn-primary" onClick={addTransfer}><Check size={14} /> Guardar</button>
                <button className="text-sm text-[#7A7263] px-2" onClick={() => setTransferForm(null)}>Cancelar</button>
              </div>
            </div>
          )}
        </div>
      </div>
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
                    <>
                      <div className="stamp text-[12px] text-[#7A7263] mt-3 mb-1">MATERIALES</div>
                      {materialesT.map((m) => <Row key={m.id} label={`${m.descripcion} · ${fmtDate(m.fecha)}`} value={money(m.monto)} />)}
                    </>
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
    if (!reembolsosTrabajo[p]) reembolsosTrabajo[p] = { nombre, materiales: 0, nomina: 0, total: 0 };
    if (tipo === "Material") reembolsosTrabajo[p].materiales += Number(item.monto);
    else reembolsosTrabajo[p].nomina += Number(item.monto);
    reembolsosTrabajo[p].total += Number(item.monto);
  };
  materialesT.forEach((m) => acumular(m, "Material"));
  nominaT.forEach((n) => acumular(n, "Nómina"));
  const listaReembolsos = Object.values(reembolsosTrabajo);

  // Primero se reembolsa a quien puso dinero de su bolsa, y lo que resta se divide 50/50 entre los socios
  const totalReembolsosTrabajo = listaReembolsos.reduce((s, r) => s + r.total, 0);
  const restoARepartir = c.ganancia - totalReembolsosTrabajo;
  const mitadResto = restoARepartir / 2;
  const reembolsoDeSocio = (socioId) => reembolsosTrabajo[socioId]?.total || 0;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start sm:items-center justify-center p-3 overflow-y-auto">
      <div className="bg-white w-full max-w-md my-4">
        <div className="no-print flex justify-between items-center p-3 bg-[#1E2A38]">
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

          <div className="text-sm font-bold uppercase mb-2">Materiales</div>
          {materialesT.length === 0 && <div className="text-sm mb-2">— sin materiales —</div>}
          {materialesT.map((m) => (
            <div key={m.id} className="flex justify-between text-base py-1">
              <span className="pr-2">{m.descripcion}</span>
              <span className="whitespace-nowrap font-semibold">{money(m.monto)}</span>
            </div>
          ))}
          <div className="flex justify-between text-base font-bold pt-2 border-t border-black mt-1">
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
          <div className="flex justify-between text-2xl font-bold py-2" style={{ color: c.ganancia >= 0 ? "#1E6B3E" : "#A13D2E" }}>
            <span>GANANCIA</span>
            <span>{money(c.ganancia)}</span>
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
            {data.socios.map((s) => {
              const reembolsoPropio = reembolsoDeSocio(s.id);
              return (
                <div key={s.id} className="text-center py-2 px-1" style={{ background: "#F5F3EE" }}>
                  <div className="text-xs uppercase tracking-wide" style={{ color: "#777" }}>{s.nombre}</div>
                  <div className="text-xl font-bold mt-0.5">{money(mitadResto + reembolsoPropio)}</div>
                  {reembolsoPropio > 0 && (
                    <div className="text-[10px] mt-1 leading-tight" style={{ color: "#888" }}>
                      {money(mitadResto)} + {money(reembolsoPropio)} reemb.
                    </div>
                  )}
                </div>
              );
            })}
          </div>

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
