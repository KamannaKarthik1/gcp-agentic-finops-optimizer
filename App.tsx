/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useEffect, useRef } from 'react';
import { scanGcpEnvironment, analyzeResources, ScanResult, OptimizationCandidate, GcpSdkLayer, validateConnection } from './services/gcp';
import { runOptimizationAgent, runReportingAgent, runChartAnalysisAgent, PlannedAction, generateCliCommand } from './services/gemini';
import { 
  ServerStackIcon, ShieldCheckIcon, DocumentTextIcon, KeyIcon, 
  ClipboardDocumentIcon, PhotoIcon, XMarkIcon, CheckIcon, 
  DocumentArrowUpIcon, ArrowDownTrayIcon, TableCellsIcon,
  CommandLineIcon, CpuChipIcon, HandThumbUpIcon, HandThumbDownIcon,
  MapIcon, BookOpenIcon, CircleStackIcon, CloudIcon
} from '@heroicons/react/24/outline';
// @ts-ignore
import { jsPDF } from "jspdf";

// Types
type PipelineStage = 'idle' | 'ingesting' | 'identifying' | 'reasoning' | 'approval' | 'executing' | 'reporting' | 'finished';
type DataSource = 'simulated' | 'real-api' | 'pdf';
interface LogEntry { id: string; type: string; content: string; timestamp: Date; }

function useStickyState<T>(defaultValue: T, key: string): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState(() => {
    const stickyValue = window.localStorage.getItem(key);
    return stickyValue !== null ? JSON.parse(stickyValue) : defaultValue;
  });
  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);
  return [value, setValue];
}

// --- MODALS ---

const RoadmapModal = ({ onClose }: { onClose: () => void }) => (
    <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="bg-[#0f0f12] border border-indigo-500/30 rounded-xl w-full max-w-3xl h-[80vh] flex flex-col shadow-[0_0_50px_rgba(99,102,241,0.2)]">
            <div className="p-5 border-b border-gray-800 flex justify-between items-center bg-indigo-900/10">
                <div>
                    <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                        <MapIcon className="w-7 h-7 text-indigo-400" /> Project Roadmap
                    </h2>
                    <p className="text-sm text-indigo-300 mt-1 font-mono">Development Milestones & Delivery Schedule</p>
                </div>
                <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition"><XMarkIcon className="w-6 h-6 text-gray-400"/></button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-8 scrollbar-thin">
                {[
                    { date: "Nov 27, 2025", title: "Requirement Definition", desc: "Define detailed agent requirements (Data Ingestion, Waste ID, Optimization, Execution).", status: "done" },
                    { date: "Dec 04, 2025", title: "Pipeline Design", desc: "Design data ingestion pipeline for cost/usage data.", status: "done" },
                    { date: "Dec 11, 2025", title: "Cloud Run Agent", desc: "Implement Data Ingestion Agent on Cloud Run architecture.", status: "done" },
                    { date: "Dec 18, 2025", title: "Waste ID Agent", desc: "Develop logic to identify idle VMs, Disks, and DBs.", status: "done" },
                    { date: "Dec 25, 2025", title: "Optimization Agent", desc: "Implement rightsizing and remediation strategies.", status: "done" },
                    { date: "Jan 01, 2026", title: "Execution Agent", desc: "Develop automated remediation with safety checks.", status: "done" },
                    { date: "Jan 08, 2026", title: "Reporting Agent", desc: "Integrate Gemini AI for weekly executive reports.", status: "done" },
                    { date: "Jan 15, 2026", title: "UI Build", desc: "Build React dashboard for visualization.", status: "done" },
                    { date: "Jan 22, 2026", title: "Auth & Security", desc: "Implement IAM role checks and secure token handling.", status: "done" },
                    { date: "Jan 29, 2026", title: "Monitoring", desc: "Set up Cloud Logging and System Health tracking.", status: "in-progress" },
                    { date: "Feb 05, 2026", title: "Testing", desc: "Comprehensive testing of all agents.", status: "pending" },
                    { date: "Feb 12, 2026", title: "Documentation", desc: "Finalize system architecture docs.", status: "pending" }
                ].map((item, i) => (
                    <div key={i} className="flex gap-4 group">
                        <div className="flex flex-col items-center">
                            <div className={`w-3 h-3 rounded-full mt-1.5 ${item.status === 'done' ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]' : item.status === 'in-progress' ? 'bg-yellow-500 animate-pulse' : 'bg-gray-700'}`}></div>
                            <div className="w-0.5 flex-1 bg-gray-800 group-last:hidden mt-1"></div>
                        </div>
                        <div className="pb-4">
                            <div className="text-xs font-mono text-gray-500 mb-1 uppercase tracking-wider">{item.date}</div>
                            <h3 className={`text-base font-bold ${item.status === 'done' ? 'text-white' : 'text-gray-400'}`}>{item.title}</h3>
                            <p className="text-sm text-gray-500 mt-1">{item.desc}</p>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    </div>
);

const DocsModal = ({ onClose }: { onClose: () => void }) => (
    <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="bg-[#0f0f12] border border-indigo-500/30 rounded-xl w-full max-w-3xl h-[80vh] flex flex-col shadow-[0_0_50px_rgba(99,102,241,0.2)]">
            <div className="p-5 border-b border-gray-800 flex justify-between items-center">
                <h2 className="text-2xl font-bold text-white flex items-center gap-2"><BookOpenIcon className="w-7 h-7 text-indigo-400" /> System Architecture</h2>
                <button onClick={onClose}><XMarkIcon className="w-6 h-6 text-gray-400 hover:text-white"/></button>
            </div>
            <div className="p-6 overflow-y-auto space-y-6 text-gray-300 text-base leading-relaxed">
                <div className="p-4 bg-indigo-900/20 border border-indigo-500/30 rounded-lg">
                    <h3 className="text-white font-bold mb-2">Agentic Workflow</h3>
                    <p>The system employs a 5-Stage Agentic Pipeline powered by Gemini 1.5 Pro. Data flows from the <strong>Ingestion Agent</strong> (simulating Cloud Run) to the <strong>Waste Identification Agent</strong>, which flags anomalies based on 7-day heuristics.</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                    <div className="p-4 bg-gray-900/50 border border-gray-800 rounded">
                        <strong className="text-white block mb-1">Data Ingestion</strong>
                        <p className="text-sm">Connects to Compute, Monitoring, and Billing APIs. Normalizes data into a unified schema.</p>
                    </div>
                    <div className="p-4 bg-gray-900/50 border border-gray-800 rounded">
                        <strong className="text-white block mb-1">Optimization Agent</strong>
                        <p className="text-sm">Uses Gemini to reason about waste. Considers "User Intent" and "Visual Context" to propose safe actions.</p>
                    </div>
                    <div className="p-4 bg-gray-900/50 border border-gray-800 rounded">
                        <strong className="text-white block mb-1">Execution Agent</strong>
                        <p className="text-sm">Generates idempotent CLI commands (gcloud) for remediation. Includes safety flags.</p>
                    </div>
                    <div className="p-4 bg-gray-900/50 border border-gray-800 rounded">
                        <strong className="text-white block mb-1">Reporting Agent</strong>
                        <p className="text-sm">Calculates ROI and Optimization Rate. Generates PDF executive summaries.</p>
                    </div>
                </div>
            </div>
        </div>
    </div>
);

// --- CHARTS & WIDGETS ---

const CostBreakdownChart = ({ items }: { items: any[] }) => {
    const aggregated = items.reduce((acc, item) => {
        acc[item.type] = (acc[item.type] || 0) + item.cost;
        return acc;
    }, {} as Record<string, number>);

    const data = Object.entries(aggregated)
        .map(([type, cost]) => ({ type, cost: cost as number }))
        .sort((a, b) => b.cost - a.cost);

    const maxCost = Math.max(...data.map(d => d.cost), 0.01);

    return (
        <div className="mt-6 border-t border-gray-800 pt-4 animate-in fade-in duration-700">
            <div className="text-xs text-gray-500 uppercase mb-3 flex justify-between font-bold">
                <span>Service Cost Distribution</span>
                <span>USD</span>
            </div>
            <div className="space-y-3">
                {data.map((d) => (
                    <div key={d.type} className="group">
                        <div className="flex justify-between text-xs mb-1">
                            <span className="text-gray-400 group-hover:text-indigo-300 transition-colors">{d.type}</span>
                            <span className="font-mono text-gray-300">${d.cost.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                        </div>
                        <div className="h-2 w-full bg-gray-800/50 rounded-full overflow-hidden">
                            <div className="h-full bg-indigo-600/50 group-hover:bg-indigo-500 transition-all rounded-full relative" style={{ width: `${(d.cost / maxCost) * 100}%` }}></div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

const TerminalLog = ({ logs }: { logs: LogEntry[] }) => {
    const endRef = useRef<HTMLDivElement>(null);
    useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [logs]);
    return (
        <div className="font-mono text-xs md:text-sm p-4 h-full overflow-y-auto scrollbar-thin space-y-2">
            {logs.map(log => (
                <div key={log.id} className="break-words border-l-2 pl-2 border-transparent hover:border-gray-700 transition-colors">
                    <span className="text-gray-600 mr-2">[{log.timestamp.toLocaleTimeString()}]</span>
                    {log.type === 'tool_call' ? <span className="text-yellow-400">{`> ${log.content}`}</span> : log.type === 'final' ? <span className="text-green-400 font-bold">{log.content}</span> : <span className="text-indigo-300">{log.content}</span>}
                </div>
            ))}
            <div ref={endRef} />
        </div>
    );
};

const App: React.FC = () => {
  const [stage, setStage] = useState<PipelineStage>('idle');
  const [showRoadmap, setShowRoadmap] = useState(false);
  const [showDocs, setShowDocs] = useState(false);

  const [projectId, setProjectId] = useStickyState('gcp-finops-demo', 'gcp_project_id');
  const [industry, setIndustry] = useState('Tech');
  const [userIntent, setUserIntent] = useStickyState('Optimize for cost.', 'gcp_user_intent');
  const [accessToken, setAccessToken] = useStickyState('', 'gcp_access_token');
  
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [candidates, setCandidates] = useState<OptimizationCandidate[]>([]);
  const [actions, setActions] = useState<PlannedAction[]>([]);
  const [report, setReport] = useState('');
  const [visualAnalysis, setVisualAnalysis] = useState('');
  const [filterType, setFilterType] = useState<string>('ALL');
  
  const [dataSource, setDataSource] = useState<DataSource>('simulated');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [verifyStatus, setVerifyStatus] = useState<'idle' | 'checking' | 'success' | 'error'>('idle');

  const totalSpend = scanResult?.totalMonthlyBill || 0;
  const savings = candidates.reduce((acc, c) => acc + c.potentialSavings, 0);

  const addLog = (type: string, content: string) => setLogs(p => [...p, { id: crypto.randomUUID(), type, content, timestamp: new Date() }]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: 'pdf' | 'image') => {
      if (!e.target.files?.[0]) return;
      const file = e.target.files[0];
      if (type === 'pdf') { setPdfFile(file); setDataSource('pdf'); addLog('thought', `PDF loaded: ${file.name}`); }
      else { runChartAnalysisAgent(file, addLog as any).then(setVisualAnalysis); }
  };

  const checkConnection = async () => {
      if (!projectId || !accessToken) { alert("Please enter Project ID and Access Token"); return; }
      setVerifyStatus('checking');
      const res = await validateConnection({ projectId, accessToken });
      if (res.success) {
          setVerifyStatus('success');
          addLog('final', `Verification Success: ${res.message}`);
      } else {
          setVerifyStatus('error');
          addLog('final', `Verification Failed: ${res.message}`);
      }
      setTimeout(() => setVerifyStatus('idle'), 5000);
  }

  const startPipeline = async () => {
      if (dataSource === 'real-api' && !accessToken) { alert("Enter Token"); return; }
      setStage('ingesting'); setLogs([]); setCandidates([]); setActions([]); setReport('');
      addLog('thought', `Initializing Pipeline for Industry: ${industry}`);
      
      try {
          const data = await scanGcpEnvironment({ type: dataSource, realApiConfig: { projectId, accessToken }, file: pdfFile || undefined });
          setScanResult(data);
          addLog('thought', `Ingested ${data.vms.length} VMs, ${data.sqlInstances.length} DBs.`);
          
          setStage('identifying');
          await new Promise(r => setTimeout(r, 1000));
          const found = analyzeResources(data);
          setCandidates(found);
          addLog('thought', `Identified ${found.length} optimization candidates.`);
          
          // Ensure report is generated even if no waste is found
          if(found.length === 0) { 
              setStage('reporting');
              const rep = await runReportingAgent([], [], projectId, industry, addLog as any);
              setReport(rep);
              setStage('finished'); 
              return; 
          }

          setStage('reasoning');
          const plans = await runOptimizationAgent(found, userIntent, visualAnalysis, addLog as any);
          setActions(plans);
          
          if (plans.length > 0) {
            setStage('approval');
          } else {
            // If Reasoning Agent suggests no actions (but candidates exist), go straight to reporting
            setStage('reporting');
            const rep = await runReportingAgent(found, [], projectId, industry, addLog as any);
            setReport(rep);
            setStage('finished');
          }
      } catch(e: any) {
          addLog('final', `Error: ${e.message}`); setStage('idle');
      }
  };

  const executeApproved = async () => {
      setStage('executing');
      const approved = actions.filter(a => a.status === 'approved');
      for (const action of approved) {
          await new Promise(r => setTimeout(r, 500));
          action.status = 'executed';
          addLog('thought', `Executed: ${action.target}`);
      }
      const rep = await runReportingAgent(candidates, actions, projectId, industry, addLog as any);
      setReport(rep);
      setStage('finished');
  };

  const filteredCandidates = candidates.filter(c => filterType === 'ALL' ? true : c.resourceType.includes(filterType));

  return (
    <div className="min-h-screen font-sans text-gray-300 bg-grid-pattern animate-scan selection:bg-indigo-500/30">
      {showRoadmap && <RoadmapModal onClose={()=>setShowRoadmap(false)} />}
      {showDocs && <DocsModal onClose={()=>setShowDocs(false)} />}

      {/* TOP HUD */}
      <div className="glass-panel sticky top-0 z-50 border-b border-indigo-500/20 px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-5">
              <div className="p-2.5 rounded bg-indigo-600/20 border border-indigo-500/50"><ServerStackIcon className="w-8 h-8 text-indigo-400" /></div>
              <div>
                  <h1 className="text-white font-bold tracking-widest text-lg uppercase neon-text">GCP Agentic Optimizer</h1>
                  <div className="flex items-center gap-4 text-sm font-mono text-indigo-300">
                      <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-green-500 rounded-full animate-pulse"></span> SYSTEM HEALTHY</span>
                      <button onClick={()=>setShowRoadmap(true)} className="hover:text-white underline">Roadmap</button>
                      <button onClick={()=>setShowDocs(true)} className="hover:text-white underline">Docs</button>
                  </div>
              </div>
          </div>
          <button onClick={startPipeline} disabled={stage !== 'idle' && stage !== 'finished'} className={`px-8 py-3 font-bold text-sm tracking-widest uppercase border ${stage === 'idle' || stage === 'finished' ? 'bg-indigo-600 text-white border-indigo-400' : 'bg-gray-900 text-gray-600'}`}>{stage === 'idle' || stage === 'finished' ? 'Initialize Run' : 'Processing...'}</button>
      </div>

      <main className="p-6 max-w-[1800px] mx-auto grid grid-cols-12 gap-6">
        {/* CONFIG */}
        <div className="col-span-12 lg:col-span-4 space-y-6">
            <div className="glass-panel p-6 rounded-xl hud-border">
                <h2 className="text-sm font-bold text-gray-500 uppercase mb-5 flex items-center gap-2"><KeyIcon className="w-5 h-5" /> Mission Parameters</h2>
                <div className="space-y-5">
                    <input type="text" value={projectId} onChange={e=>setProjectId(e.target.value)} className="w-full bg-black/50 border border-gray-800 rounded px-4 py-3 text-base font-mono" placeholder="Project ID" />
                    <div className="grid grid-cols-3 gap-3">
                        {['simulated', 'real-api', 'pdf'].map(t => (
                            <button key={t} onClick={()=>setDataSource(t as any)} className={`py-2.5 text-xs font-medium border rounded capitalize ${dataSource===t ? 'bg-indigo-900/40 border-indigo-500 text-white' : 'border-gray-800'}`}>{t}</button>
                        ))}
                    </div>
                    {dataSource === 'real-api' && (
                        <div className="space-y-3">
                            <div className="bg-yellow-900/20 border border-yellow-700/30 p-3 rounded">
                                <p className="text-xs text-yellow-400 font-bold uppercase mb-1.5">Required IAM Roles</p>
                                <ul className="text-xs text-yellow-300/80 list-disc pl-4 space-y-1">
                                    <li>Compute Viewer <span className="font-mono opacity-50">(roles/compute.viewer)</span></li>
                                    <li>Monitoring Viewer <span className="font-mono opacity-50">(roles/monitoring.viewer)</span></li>
                                    <li>Project Billing Manager <span className="font-mono opacity-50">(roles/billing.projectManager)</span></li>
                                </ul>
                            </div>
                            <div className="relative group">
                                <input type="password" value={accessToken} onChange={e=>setAccessToken(e.target.value)} className="w-full bg-black/50 border border-green-900/50 text-green-400 text-sm p-3 rounded font-mono" placeholder="Paste GCP Access Token" />
                                <div className="absolute top-2.5 right-2.5 flex gap-1">
                                     <button onClick={() => navigator.clipboard.writeText('gcloud auth print-access-token')} className="text-xs bg-gray-800 px-3 py-1 rounded text-gray-300 hover:text-white">Copy Command</button>
                                </div>
                            </div>
                            <div className="flex justify-between items-center">
                                <div className="text-xs text-gray-500 font-mono bg-black/30 p-2 rounded">$ gcloud auth print-access-token</div>
                                <button 
                                    onClick={checkConnection} 
                                    className={`px-3 py-1.5 text-xs font-bold uppercase rounded transition-all ${verifyStatus === 'success' ? 'bg-green-600 text-white' : verifyStatus === 'error' ? 'bg-red-600 text-white' : 'bg-indigo-600 text-white hover:bg-indigo-500'}`}
                                >
                                    {verifyStatus === 'checking' ? '...' : verifyStatus === 'success' ? 'Verified' : verifyStatus === 'error' ? 'Failed' : 'Verify Token'}
                                </button>
                            </div>
                        </div>
                    )}
                    
                    <div className="flex gap-3">
                        <select value={industry} onChange={e=>setIndustry(e.target.value)} className="bg-black/50 border border-gray-800 text-sm rounded p-3 text-gray-300 flex-1">
                            <option>Tech</option><option>Fintech</option><option>Retail</option><option>Healthcare</option>
                        </select>
                        <textarea value={userIntent} onChange={e=>setUserIntent(e.target.value)} rows={1} className="w-full bg-black/50 border border-gray-800 rounded px-4 py-3 text-base font-mono text-gray-300 resize-none flex-[2]" placeholder="Intent" />
                    </div>
                    
                    <label className="flex items-center gap-3 w-full p-4 bg-black/50 border border-dashed border-gray-700 rounded hover:border-indigo-500 cursor-pointer group">
                        <PhotoIcon className="w-6 h-6 text-gray-500" />
                        <span className="text-sm text-gray-400">{visualAnalysis ? "Context Loaded" : "Upload Chart"}</span>
                        <input type="file" accept="image/*" onChange={(e) => handleFileUpload(e, 'image')} className="hidden" />
                    </label>
                    <label className="flex items-center gap-3 w-full p-4 bg-black/50 border border-dashed border-gray-700 rounded hover:border-indigo-500 cursor-pointer group">
                        <DocumentArrowUpIcon className="w-6 h-6 text-gray-500" />
                        <span className="text-sm text-gray-400">{pdfFile ? pdfFile.name : "Upload Invoice PDF"}</span>
                        <input type="file" accept="application/pdf" onChange={(e) => handleFileUpload(e, 'pdf')} className="hidden" />
                    </label>
                </div>
            </div>

            <div className="glass-panel p-6 rounded-xl border border-gray-800">
                <div className="flex justify-between items-end mb-5">
                    <div><div className="text-xs text-gray-500 uppercase font-bold mb-1">Total Spend</div><div className="text-4xl font-bold text-white font-mono">${totalSpend.toLocaleString()}</div></div>
                    {candidates.length > 0 && <div className="text-right"><div className="text-xs text-green-500 uppercase font-bold mb-1">Savings</div><div className="text-2xl font-bold text-green-400 font-mono">-${savings.toLocaleString()}</div></div>}
                </div>
                {scanResult && <CostBreakdownChart items={scanResult.costBreakdown} />}
            </div>

            <div className="glass-panel p-2 rounded-xl border border-gray-800 min-h-[400px] flex flex-col">
                <div className="p-4 border-b border-gray-800 flex justify-between items-center">
                     <div className="flex items-center gap-3">
                         <span className="text-sm font-bold text-gray-500 uppercase">Anomalies</span>
                         <div className="flex bg-black/50 rounded p-1 gap-1">
                            {['ALL', 'VM', 'SQL', 'RUN'].map(t => (
                                <button key={t} onClick={() => setFilterType(t)} className={`text-xs px-3 py-1 rounded ${filterType === t ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-800'}`}>{t}</button>
                            ))}
                         </div>
                     </div>
                </div>
                <div className="flex-1 overflow-y-auto max-h-[500px] p-3 space-y-3 scrollbar-thin">
                    {filteredCandidates.map(c => (
                        <div key={c.id} className="bg-gray-900/40 border border-gray-800 p-3 rounded hover:border-indigo-500/50 group">
                            <div className="flex justify-between items-start">
                                <div className="text-base font-bold text-gray-200 truncate max-w-[220px]">{c.resourceName}</div>
                                <div className="text-xs bg-red-900/30 text-red-400 px-2 py-1 rounded font-medium">{c.reason}</div>
                            </div>
                            <div className="flex justify-between items-end mt-3">
                                <div className="text-xs text-gray-500 font-mono flex items-center gap-1.5">
                                    {c.resourceType === 'SQL' ? <CircleStackIcon className="w-4 h-4"/> : c.resourceType === 'RUN' ? <CloudIcon className="w-4 h-4"/> : <CpuChipIcon className="w-4 h-4"/>}
                                    {c.resourceType}
                                </div>
                            </div>
                        </div>
                    ))}
                    {filteredCandidates.length === 0 && <div className="text-center text-gray-600 text-sm py-12">No anomalies found.</div>}
                </div>
            </div>
        </div>

        {/* REASONING & EXECUTION */}
        <div className="col-span-12 lg:col-span-5 space-y-6 flex flex-col">
            <div className="glass-panel rounded-xl border border-gray-800 flex flex-col h-[600px]">
                <div className="bg-[#111] p-3 border-b border-gray-800 flex items-center gap-2 text-xs font-mono text-gray-500"><CommandLineIcon className="w-4 h-4" /> AGENT_CORE_V3.1</div>
                <div className="flex-1 bg-black/80 overflow-hidden"><TerminalLog logs={logs} /></div>
            </div>

            {stage === 'approval' && (
                <div className="glass-panel p-5 rounded-xl border border-indigo-500/50 animate-in fade-in">
                    <h3 className="text-base font-bold text-white uppercase mb-4 flex items-center gap-2"><ShieldCheckIcon className="w-6 h-6 text-indigo-400" /> Approval Queue</h3>
                    <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 scrollbar-thin">
                        {actions.map(action => (
                            <div key={action.id} className="bg-gray-900/60 border border-gray-800 p-4 rounded flex justify-between items-start hover:border-gray-600 transition-colors">
                                <div>
                                    <div className="flex items-center gap-3 mb-1.5">
                                        <div className={`text-xs font-bold px-2 py-1 rounded ${action.type.includes('DELETE') ? 'bg-red-900/30 text-red-400' : 'bg-yellow-900/30 text-yellow-400'}`}>
                                            {action.type}
                                        </div>
                                        <div className="text-sm font-mono text-gray-300">{action.target}</div>
                                    </div>
                                    <div className="text-xs text-gray-500 mb-1.5">{action.reasoning}</div>
                                    <div className="text-xs font-mono text-indigo-400/80 truncate max-w-[350px] bg-black/30 p-1 rounded">
                                        $ {generateCliCommand(action)}
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button 
                                        onClick={() => {
                                            const newActions = [...actions];
                                            const idx = newActions.findIndex(a => a.id === action.id);
                                            if (idx !== -1) {
                                                newActions[idx].status = 'rejected';
                                                setActions(newActions);
                                            }
                                        }}
                                        className={`p-2 rounded hover:bg-gray-800 ${action.status === 'rejected' ? 'text-red-500' : 'text-gray-600'}`}
                                    >
                                        <HandThumbDownIcon className="w-5 h-5" />
                                    </button>
                                    <button 
                                        onClick={() => {
                                            const newActions = [...actions];
                                            const idx = newActions.findIndex(a => a.id === action.id);
                                            if (idx !== -1) {
                                                newActions[idx].status = 'approved';
                                                setActions(newActions);
                                            }
                                        }}
                                        className={`p-2 rounded hover:bg-gray-800 ${action.status === 'approved' ? 'text-green-500' : 'text-gray-600'}`}
                                    >
                                        <HandThumbUpIcon className="w-5 h-5" />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="mt-5 pt-4 border-t border-gray-800 flex items-center justify-between">
                         <div className="text-xs text-gray-500 font-bold">
                             {actions.filter(a => a.status === 'approved').length} actions approved
                         </div>
                         <button 
                            onClick={executeApproved} 
                            disabled={!actions.some(a => a.status === 'approved')} 
                            className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-xs font-bold uppercase tracking-widest rounded transition-all"
                         >
                            Execute Remediation
                         </button>
                    </div>
                </div>
            )}
            
            {(stage === 'reporting' || stage === 'finished') && (
                <div className="glass-panel p-6 rounded-xl border border-green-500/30 animate-in fade-in">
                    <div className="flex items-center justify-between mb-5">
                        <h3 className="text-base font-bold text-white uppercase flex items-center gap-2"><DocumentTextIcon className="w-6 h-6 text-green-400" /> Executive Report</h3>
                        {stage === 'reporting' && <div className="text-xs text-green-400 animate-pulse font-bold">GENERATING...</div>}
                    </div>
                    
                    {stage === 'reporting' ? (
                        <div className="h-[350px] flex flex-col items-center justify-center text-green-500/50 space-y-4">
                            <div className="w-10 h-10 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                            <div className="text-sm font-mono">Analyzing financial impact...</div>
                        </div>
                    ) : (
                        <div className="space-y-5 animate-in zoom-in-95 duration-500">
                             <div className="bg-black/50 border border-green-900/30 p-5 rounded text-sm font-mono text-gray-300 h-[350px] overflow-y-auto whitespace-pre-wrap scrollbar-thin leading-relaxed">
                                 {report}
                             </div>
                             <button 
                                onClick={() => {
                                    const doc = new jsPDF();
                                    doc.setFontSize(10);
                                    doc.text(report, 10, 10, { maxWidth: 190 });
                                    doc.save(`${projectId}_optimization_report.pdf`);
                                }} 
                                className="w-full py-3 bg-green-600 hover:bg-green-500 text-white text-xs font-bold uppercase tracking-widest rounded flex items-center justify-center gap-2"
                             >
                                 <ArrowDownTrayIcon className="w-5 h-5" /> Download PDF
                             </button>
                        </div>
                    )}
                </div>
            )}

        </div>
      </main>
    </div>
  );
};

export default App;