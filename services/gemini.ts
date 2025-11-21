/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI, Type, FunctionDeclaration, Tool, Part } from "@google/genai";
import { OptimizationCandidate } from "./gcp";

const GEMINI_MODEL = 'gemini-2.5-flash';
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export type AgentLogCallback = (type: 'thought' | 'tool_call' | 'tool_result' | 'final', content: string) => void;

const MAX_LOOPS = 8;

// ==============================================================================
// MCP (MODEL CONTEXT PROTOCOL)
// ==============================================================================

interface McpResource {
    uri: string; 
    mimeType: string;
    name: string;
    metadata: {
        cost: number;
        usage_7d: number;
        tags: Record<string, string>;
        state: string;
        spec?: string;
    };
}

const convertToMcpContext = (candidates: OptimizationCandidate[]): McpResource[] => {
    return candidates.map(c => ({
        uri: `gcp://resources/${c.resourceType.toLowerCase()}/${c.resourceName}`,
        mimeType: "application/vnd.google.cloud.resource+json",
        name: c.resourceName,
        metadata: {
            cost: c.potentialSavings,
            usage_7d: c.resourceType === 'VM' ? (c.rawData as any).cpu7DayAvg : 0,
            tags: c.rawData.labels || {},
            state: c.reason,
            spec: c.resourceType
        }
    }));
};

// ==============================================================================
// CHART VISION AGENT
// ==============================================================================

export async function runChartAnalysisAgent(
    imageFile: File, 
    logCallback: AgentLogCallback
): Promise<string> {
    logCallback('thought', `[Vision] Scanning visual telemetry...`);
    try {
        const base64Data = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
            reader.readAsDataURL(imageFile);
        });

        const response = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: {
                role: "user",
                parts: [
                    { text: "Analyze this cost/usage chart. Identify spikes or plateaus." },
                    { inlineData: { mimeType: imageFile.type, data: base64Data } }
                ]
            }
        });
        return response.text || "No visual anomalies detected.";
    } catch (e) {
        return "Vision analysis unavailable.";
    }
}

// ==============================================================================
// OPTIMIZATION REASONING AGENT
// ==============================================================================

// Tool Definitions
const shutdownVmTool: FunctionDeclaration = {
  name: 'plan_shutdown_vm',
  description: 'Propose stopping an idle VM instance.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      instance_name: { type: Type.STRING },
      zone: { type: Type.STRING },
      confidence_score: { type: Type.INTEGER },
      reasoning: { type: Type.STRING }
    },
    required: ['instance_name', 'zone', 'confidence_score', 'reasoning']
  }
};

const rightsizeVmTool: FunctionDeclaration = {
  name: 'plan_rightsize_vm',
  description: 'Propose downsizing a VM machine type.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      instance_name: { type: Type.STRING },
      current_type: { type: Type.STRING },
      new_type: { type: Type.STRING },
      zone: { type: Type.STRING },
      confidence_score: { type: Type.INTEGER },
      reasoning: { type: Type.STRING }
    },
    required: ['instance_name', 'current_type', 'new_type', 'zone', 'confidence_score', 'reasoning']
  }
};

const deleteDiskTool: FunctionDeclaration = {
  name: 'plan_delete_disk',
  description: 'Propose deleting an orphaned disk.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      disk_name: { type: Type.STRING },
      zone: { type: Type.STRING },
      confidence_score: { type: Type.INTEGER },
      reasoning: { type: Type.STRING }
    },
    required: ['disk_name', 'zone', 'confidence_score', 'reasoning']
  }
};

const deleteSqlTool: FunctionDeclaration = {
    name: 'plan_delete_sql',
    description: 'Propose deleting an idle Cloud SQL database instance.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        instance_name: { type: Type.STRING },
        region: { type: Type.STRING },
        confidence_score: { type: Type.INTEGER },
        reasoning: { type: Type.STRING }
      },
      required: ['instance_name', 'region', 'confidence_score', 'reasoning']
    }
};

const deleteRunTool: FunctionDeclaration = {
    name: 'plan_delete_run',
    description: 'Propose deleting an unused Cloud Run service.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        service_name: { type: Type.STRING },
        region: { type: Type.STRING },
        confidence_score: { type: Type.INTEGER },
        reasoning: { type: Type.STRING }
      },
      required: ['service_name', 'region', 'confidence_score', 'reasoning']
    }
};

const tools: Tool = {
  functionDeclarations: [shutdownVmTool, rightsizeVmTool, deleteDiskTool, deleteSqlTool, deleteRunTool]
};

export interface PlannedAction {
    id: string;
    type: 'STOP_VM' | 'RIGHTSIZE_VM' | 'DELETE_DISK' | 'DELETE_SQL' | 'DELETE_RUN';
    target: string;
    zone: string;
    confidence: number;
    reasoning: string;
    status: 'pending' | 'approved' | 'rejected' | 'executed';
    details?: { from?: string; to?: string };
}

export async function runOptimizationAgent(
  candidates: OptimizationCandidate[], 
  userIntent: string,
  visualAnalysis: string,
  logCallback: AgentLogCallback
): Promise<PlannedAction[]> {
  
  const mcpContext = convertToMcpContext(candidates);
  
  const chat = ai.chats.create({
    model: GEMINI_MODEL,
    config: {
      systemInstruction: `You are the GCP Optimization Reasoning Agent.
      
      **Mission**: Identify waste and propose remediation.
      **Criteria**:
      - Idle VM -> plan_shutdown_vm
      - Over-provisioned VM -> plan_rightsize_vm
      - Orphaned Disk -> plan_delete_disk
      - Idle Database -> plan_delete_sql
      - Unused Service -> plan_delete_run

      **User Intent**: ${userIntent}
      **Vision Context**: ${visualAnalysis}

      **Safety**:
      - NEVER delete 'prod' databases without 95%+ confidence.
      - Prefer Rightsizing over Deletion for VMs with >0% usage.
      `,
      tools: [tools],
      temperature: 0.1
    }
  });

  const prompt = `
  [MCP Context]
  ${JSON.stringify(mcpContext, null, 2)}
  
  Evaluate and act.
  `;

  logCallback('thought', `[Reasoning] Loaded ${mcpContext.length} resources...`);

  const plannedActions: PlannedAction[] = [];
  let loopCount = 0;

  try {
    let response = await chat.sendMessage({ message: prompt });
    
    while (response.functionCalls && response.functionCalls.length > 0) {
      loopCount++;
      if (loopCount > MAX_LOOPS) break;

      const parts: Part[] = [];

      for (const call of response.functionCalls) {
        const { name, args, id } = call;
        
        let actionType: PlannedAction['type'] = 'STOP_VM';
        let target = '';
        let details = {};
        let zone = args.zone as string || args.region as string || 'global';
        
        if (name === 'plan_shutdown_vm') {
            actionType = 'STOP_VM';
            target = args.instance_name as string;
        } else if (name === 'plan_rightsize_vm') {
            actionType = 'RIGHTSIZE_VM';
            target = args.instance_name as string;
            details = { from: args.current_type, to: args.new_type };
        } else if (name === 'plan_delete_disk') {
            actionType = 'DELETE_DISK';
            target = args.disk_name as string;
        } else if (name === 'plan_delete_sql') {
            actionType = 'DELETE_SQL';
            target = args.instance_name as string;
        } else if (name === 'plan_delete_run') {
            actionType = 'DELETE_RUN';
            target = args.service_name as string;
        }

        const plan: PlannedAction = {
            id: crypto.randomUUID(),
            type: actionType,
            target: target,
            zone: zone,
            confidence: args.confidence_score as number || 50,
            reasoning: args.reasoning as string || "Automated finding",
            status: 'pending',
            details: details
        };

        plannedActions.push(plan);
        logCallback('tool_call', `Tool: ${name} -> ${target}`);

        parts.push({
            functionResponse: {
                id: id,
                name: name,
                response: { result: { status: 'queued' } }
            }
        });
      }
      response = await chat.sendMessage({ message: parts });
    }
    
    return plannedActions;

  } catch (error) {
    console.error("Agent Error:", error);
    logCallback('final', `Reasoning Error: ${error}`);
    return [];
  }
}

// ==============================================================================
// EXECUTION AGENT (Command Generator)
// ==============================================================================

export const generateCliCommand = (action: PlannedAction): string => {
    const base = `gcloud`;
    const flags = `--quiet --project=$PROJECT_ID`;
    
    switch (action.type) {
        case 'STOP_VM':
            return `${base} compute instances stop ${action.target} --zone=${action.zone} ${flags}`;
        
        case 'RIGHTSIZE_VM':
            return `${base} compute instances stop ${action.target} --zone=${action.zone} ${flags} && \
${base} compute instances set-machine-type ${action.target} --machine-type=${action.details?.to || 'e2-medium'} --zone=${action.zone} ${flags} && \
${base} compute instances start ${action.target} --zone=${action.zone} ${flags}`;

        case 'DELETE_DISK':
            return `${base} compute disks delete ${action.target} --zone=${action.zone} ${flags}`;

        case 'DELETE_SQL':
            return `${base} sql instances delete ${action.target} ${flags}`;

        case 'DELETE_RUN':
            return `${base} run services delete ${action.target} --region=${action.zone} ${flags}`;
            
        default:
            return `# Unknown action: ${action.type}`;
    }
};

// ==============================================================================
// REPORTING AGENT
// ==============================================================================

export async function runReportingAgent(
    candidates: OptimizationCandidate[],
    actions: PlannedAction[],
    projectId: string,
    industry: string,
    logCallback: AgentLogCallback
): Promise<string> {
    logCallback('thought', `[Reporting] Generating Executive Analysis for ${projectId}...`);

    const totalSavings = candidates.reduce((acc, c) => acc + c.potentialSavings, 0);
    const approved = actions.filter(a => a.status === 'executed');
    const rejected = actions.filter(a => a.status === 'rejected');
    
    const realizedSavings = approved.reduce((acc, a) => {
        const candidate = candidates.find(c => c.resourceName === a.target);
        return acc + (candidate ? candidate.potentialSavings : 0);
    }, 0);

    const optRate = candidates.length > 0 ? Math.round((approved.length / candidates.length) * 100) : 100;

    const isClean = candidates.length === 0;

    const prompt = `
    **Project Context**:
    - Project ID: ${projectId}
    - Industry Domain: ${industry}
    
    **Success Metrics**:
    - Total Waste Identified: $${totalSavings.toFixed(2)}
    - Realized Monthly Savings: $${realizedSavings.toFixed(2)}
    - Projected Annual ROI: $${(realizedSavings * 12).toFixed(2)}
    - Optimization Rate: ${optRate}%

    [Action Log]
    Executed: ${approved.length}
    Rejected: ${rejected.length}

    ${isClean ? "**NOTE**: No waste was found in this environment. The infrastructure is fully optimized." : ""}

    Task: Write a comprehensive Executive Report for this specific project.
    Structure:
    1. **Executive Summary**: High-level overview of financial health.
    2. **Strategic Analysis**: Industry-specific context (e.g., for ${industry}).
    3. **Key Achievements**: Highlight realized savings and security improvements.
    4. **Recommendations**: Next steps for FinOps maturity.
    `;

    try {
        const response = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: prompt,
            config: { systemInstruction: "You are a Chief FinOps Officer. You write professional, data-driven executive summaries." }
        });
        return response.text || "Report failed.";
    } catch (e) {
        return "Report generation error.";
    }
}