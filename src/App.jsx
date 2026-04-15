import { useState, useCallback, useRef } from "react";
import { useAccount, useSignTypedData, useChainId, useSwitchChain, useWriteContract } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { getAddress, ZeroAddress, TypedDataEncoder, toBigInt } from "ethers";

const API_BASE = {
  ethereum: "https://api.safe.global/tx-service/eth",
  arbitrum: "https://api.safe.global/tx-service/arb1",
  optimism: "https://api.safe.global/tx-service/oeth",
};

const CHAIN_IDS = { ethereum: 1, arbitrum: 42161, optimism: 10 };
const CHAIN_NAMES = { 1: "ethereum", 42161: "arbitrum", 10: "optimism" };

const SAFE_ABI = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    name: "execTransaction",
    outputs: [{ name: "success", type: "bool" }],
    stateMutability: "payable",
    type: "function",
  },
];

function shortAddr(addr) {
  if (!addr || typeof addr !== "string") return "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildSignatureBytes(confirmations) {
  const sorted = [...confirmations].sort((a, b) => {
    const aOwner = (a.owner || "").toLowerCase();
    const bOwner = (b.owner || "").toLowerCase();
    return aOwner < bOwner ? -1 : aOwner > bOwner ? 1 : 0;
  });

  let sigs = "0x";
  for (const c of sorted) {
    let sig = c.signature;
    if (!sig) continue;
    if (!sig.startsWith("0x")) sig = "0x" + sig;
    // Strip any contract signature prefix if present (Safe API sometimes adds it)
    // Standard ECDSA: 65 bytes (r=32 + s=32 + v=1)
    // If signature is longer than 65 bytes, it may have a contract sig prefix
    const sigBytes = sig.slice(2);
    if (sigBytes.length > 130) {
      // Contract signature: take last 65 bytes
      sigs += sigBytes.slice(-130);
    } else {
      sigs += sigBytes.padEnd(130, "0").slice(0, 130);
    }
  }
  return sigs;
}

export default function App() {
  const { address, isConnected } = useAccount();
  const walletChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();

  const [chain, setChain] = useState("arbitrum");
  const [safeAddress, setSafeAddress] = useState("");
  const [minNonce, setMinNonce] = useState(32);
  const [hideUnactionable, setHideUnactionable] = useState(false);
  const [txs, setTxs] = useState([]);
  const [safeInfo, setSafeInfo] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [signing, setSigning] = useState(false);
  const [executing, setExecuting] = useState(false);

  const txsRef = useRef(txs);
  txsRef.current = txs;
  const safeInfoRef = useRef(safeInfo);
  safeInfoRef.current = safeInfo;

  const addLog = useCallback((msg, cls = "") => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ time, msg, cls, id: Date.now() + Math.random() }, ...prev]);
  }, []);

  const connectedWalletIsOwner = useCallback(() => {
    if (!address || !safeInfo?.owners) return false;
    return safeInfo.owners.some(o => o.toLowerCase() === address.toLowerCase());
  }, [address, safeInfo]);

  const hasSigned = useCallback((tx, addr) => {
    if (!addr) return false;
    const target = addr.toLowerCase();
    const confs = Array.isArray(tx.confirmations) ? tx.confirmations : [];
    return confs.some(c => {
      const owner = c.owner || c.ownerAddress || "";
      return String(owner).toLowerCase() === target;
    });
  }, []);

  const thresholdMet = useCallback((tx) => {
    const count = Number(tx.confirmationsSubmitted ?? (Array.isArray(tx.confirmations) ? tx.confirmations.length : 0));
    const required = Number(tx.confirmationsRequired ?? safeInfo?.threshold ?? 0);
    return required > 0 && count >= required;
  }, [safeInfo]);

  const isSignable = useCallback((tx) => {
    if (!address || !connectedWalletIsOwner()) return false;
    if (thresholdMet(tx)) return false;
    if (hasSigned(tx, address)) return false;
    return true;
  }, [address, connectedWalletIsOwner, thresholdMet, hasSigned]);

  const getConfirmCount = (tx) => Number(tx.confirmationsSubmitted ?? (Array.isArray(tx.confirmations) ? tx.confirmations.length : 0));
  const getRequiredCount = (tx) => Number(tx.confirmationsRequired ?? safeInfo?.threshold ?? 0);

  const loadPending = useCallback(async () => {
    let safe;
    try { safe = getAddress(safeAddress); } catch {
      addLog("Enter a valid Safe address.", "bad");
      return;
    }
    if (!isConnected) { addLog("Connect wallet first.", "bad"); return; }

    setLoading(true);
    try {
      addLog(`Loading Safe info for ${safe} on ${chain}...`);
      const infoRes = await fetch(`${API_BASE[chain]}/api/v1/safes/${safe}/`);
      if (!infoRes.ok) throw new Error(`Safe info failed: ${infoRes.status}`);
      const info = await infoRes.json();
      setSafeInfo(info);
      addLog(`Safe threshold: ${info.threshold}`, "ok");

      if (!info.owners.some(o => o.toLowerCase() === address.toLowerCase())) {
        addLog(`Connected wallet ${address} is not in the Safe owner list.`, "bad");
      } else {
        addLog("Connected wallet is a Safe owner.", "ok");
      }

      addLog(`Loading pending transactions...`);
      const all = [];
      let nextUrl = `${API_BASE[chain]}/api/v1/safes/${safe}/multisig-transactions/?executed=false&trusted=true&queued=true`;
      while (nextUrl) {
        const res = await fetch(nextUrl);
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        const data = await res.json();
        all.push(...(data.results || []));
        nextUrl = data.next || null;
      }
      all.sort((a, b) => (Number(b.nonce ?? 0)) - (Number(a.nonce ?? 0)));
      setTxs(all);
      setSelected(new Set());
      addLog(`Loaded ${all.length} pending transaction(s).`, "ok");
    } catch (err) {
      addLog(err.message || String(err), "bad");
    } finally {
      setLoading(false);
    }
  }, [chain, safeAddress, address, isConnected, addLog]);

  const signOne = useCallback(async (tx, idx) => {
    if (!isConnected) { addLog("Connect wallet first.", "bad"); return; }
    let safe;
    try { safe = getAddress(safeAddress); } catch {
      addLog("Invalid Safe address.", "bad"); return;
    }
    if (!isSignable(tx)) {
      if (!connectedWalletIsOwner()) addLog(`Nonce ${tx.nonce}: not an owner.`, "bad");
      else if (thresholdMet(tx)) addLog(`Nonce ${tx.nonce}: threshold met.`, "warn");
      else if (hasSigned(tx, address)) addLog(`Nonce ${tx.nonce}: already signed.`, "warn");
      else addLog(`Nonce ${tx.nonce}: not signable.`, "warn");
      return;
    }

    const cid = CHAIN_IDS[chain];
    if (walletChainId !== cid) {
      try { switchChain({ chainId: cid }); } catch {
        addLog(`Switch wallet to chain ${cid} first.`, "bad"); return;
      }
    }

    try {
      addLog(`Nonce ${tx.nonce}: signing...`);

      const domain = { chainId: Number(cid), verifyingContract: getAddress(safe) };
      const types = {
        SafeTx: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
          { name: "operation", type: "uint8" },
          { name: "safeTxGas", type: "uint256" },
          { name: "baseGas", type: "uint256" },
          { name: "gasPrice", type: "uint256" },
          { name: "gasToken", type: "address" },
          { name: "refundReceiver", type: "address" },
          { name: "nonce", type: "uint256" },
        ],
      };
      const toDec = (v) => { try { return toBigInt(v ?? 0).toString(); } catch { return "0"; } };
      const value = {
        to: getAddress(tx.to),
        value: toDec(tx.value),
        data: tx.data || "0x",
        operation: Number(tx.operation ?? 0),
        safeTxGas: toDec(tx.safeTxGas),
        baseGas: toDec(tx.baseGas),
        gasPrice: toDec(tx.gasPrice),
        gasToken: tx.gasToken ? getAddress(tx.gasToken) : ZeroAddress,
        refundReceiver: tx.refundReceiver ? getAddress(tx.refundReceiver) : ZeroAddress,
        nonce: toDec(tx.nonce),
      };

      const localHash = TypedDataEncoder.hash(domain, types, value);
      if (!tx.safeTxHash) throw new Error("Missing safeTxHash from service");
      if (localHash.toLowerCase() !== tx.safeTxHash.toLowerCase()) {
        throw new Error(`Hash mismatch. Expected ${tx.safeTxHash}, got ${localHash}`);
      }
      addLog(`Nonce ${tx.nonce}: hash verified.`, "ok");

      const sig = await signTypedDataAsync({ domain, types, primaryType: "SafeTx", message: value });

      addLog(`Nonce ${tx.nonce}: submitting confirmation...`);
      const confRes = await fetch(`${API_BASE[chain]}/api/v1/multisig-transactions/${tx.safeTxHash}/confirmations/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: sig }),
      });
      if (!confRes.ok) {
        const text = await confRes.text();
        throw new Error(`Confirmation POST failed: ${confRes.status} ${text}`);
      }

      addLog(`Nonce ${tx.nonce}: confirmed!`, "ok");

      setTxs(prev => {
        const next = [...prev];
        const t = { ...next[idx] };
        t.confirmations = [...(t.confirmations || []), { owner: address, signature: sig }];
        t.confirmationsSubmitted = (t.confirmationsSubmitted ?? (t.confirmations.length - 1)) + 1;
        next[idx] = t;
        return next;
      });
    } catch (err) {
      addLog(`Nonce ${tx.nonce}: ${err.message || err}`, "bad");
    }
  }, [isConnected, safeAddress, chain, address, walletChainId, switchChain, signTypedDataAsync, isSignable, connectedWalletIsOwner, thresholdMet, hasSigned, addLog]);

  const signSelected = useCallback(async () => {
    if (!selected.size) { addLog("No transactions selected.", "warn"); return; }
    setSigning(true);
    const indices = [...selected].sort((a, b) => a - b);
    for (const idx of indices) {
      await signOne(txsRef.current[idx], idx);
    }
    setSigning(false);
  }, [selected, signOne, addLog]);

  const executeOne = useCallback(async (tx, idx) => {
    let safe;
    try { safe = getAddress(safeAddress); } catch {
      addLog("Invalid Safe address.", "bad"); return;
    }

    if (!thresholdMet(tx)) {
      addLog(`Nonce ${tx.nonce}: threshold not met, cannot execute.`, "bad");
      return;
    }

    const confs = Array.isArray(tx.confirmations) ? tx.confirmations : [];
    if (!confs.length) {
      addLog(`Nonce ${tx.nonce}: no confirmations found.`, "bad");
      return;
    }

    const cid = CHAIN_IDS[chain];
    if (walletChainId !== cid) {
      try { switchChain({ chainId: cid }); } catch {
        addLog(`Switch wallet to chain ${cid} first.`, "bad"); return;
      }
    }

    setExecuting(true);
    try {
      const signatures = buildSignatureBytes(confs);
      addLog(`Nonce ${tx.nonce}: assembled ${confs.length} signature(s) (${(signatures.length - 2) / 2} bytes).`, "ok");
      addLog(`Nonce ${tx.nonce}: submitting execTransaction...`);

      const toDec = (v) => { try { return toBigInt(v ?? 0).toString(); } catch { return "0n"; } };

      const hash = await writeContractAsync({
        address: safe,
        abi: SAFE_ABI,
        functionName: "execTransaction",
        args: [
          getAddress(tx.to),
          BigInt(toDec(tx.value)),
          tx.data || "0x",
          Number(tx.operation ?? 0),
          BigInt(toDec(tx.safeTxGas)),
          BigInt(toDec(tx.baseGas)),
          BigInt(toDec(tx.gasPrice)),
          tx.gasToken ? getAddress(tx.gasToken) : ZeroAddress,
          tx.refundReceiver ? getAddress(tx.refundReceiver) : ZeroAddress,
          signatures,
        ],
        value: BigInt(toDec(tx.value)),
      });

      addLog(`Nonce ${tx.nonce}: tx submitted! Hash: ${hash}`, "ok");
      addLog(`Nonce ${tx.nonce}: waiting for confirmation...`, "ok");

      // Mark as executed locally
      setTxs(prev => {
        const next = [...prev];
        next[idx] = { ...next[idx], _executing: false, _executedTxHash: hash };
        return next;
      });

    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      addLog(`Nonce ${tx.nonce}: execution failed — ${msg}`, "bad");
    } finally {
      setExecuting(false);
    }
  }, [safeAddress, chain, walletChainId, switchChain, thresholdMet, writeContractAsync, addLog]);

  const selectSignable = useCallback(() => {
    const next = new Set();
    txs.forEach((tx, i) => { if (isSignable(tx) || thresholdMet(tx)) next.add(i); });
    setSelected(next);
  }, [txs, isSignable, thresholdMet]);

  const switchWalletChain = useCallback(() => {
    const cid = CHAIN_IDS[chain];
    try { switchChain({ chainId: cid }); addLog(`Switching wallet to chain ${cid}...`, "ok"); }
    catch (err) { addLog(err.message, "bad"); }
  }, [chain, switchChain, addLog]);

  const visibleTxs = txs.filter(tx => {
    const nonceOk = Number(tx.nonce ?? 0) > minNonce;
    if (!nonceOk) return false;
    if (hideUnactionable && !isSignable(tx) && !thresholdMet(tx)) return false;
    return true;
  });

  const signableCount = visibleTxs.filter(isSignable).length;
  const alreadySignedCount = visibleTxs.filter(tx => hasSigned(tx, address)).length;
  const thresholdDoneCount = visibleTxs.filter(thresholdMet).length;

  return (
    <div>
      <div className="app-title">SignIt — Safe Multisig Signer</div>
      <div className="app-subtitle">安全マルチシグ署名端末</div>
      <div className="app-classification">NERV OPERATIONS — MULTISIG CONFIRMATION PROTOCOL</div>

      <div className="wallet-bar">
        <ConnectButton />
      </div>

      <div className="row">
        <label>Chain</label>
        <select value={chain} onChange={e => setChain(e.target.value)}>
          <option value="ethereum">Ethereum</option>
          <option value="arbitrum">Arbitrum</option>
          <option value="optimism">Optimism</option>
        </select>

        <button onClick={switchWalletChain}>Switch Wallet Chain</button>

        <label>Safe Address</label>
        <input type="text" placeholder="0x..." value={safeAddress}
          onChange={e => setSafeAddress(e.target.value)} style={{ minWidth: 360 }} />

        <label>Min nonce</label>
        <input type="number" value={minNonce} min={0} step={1}
          onChange={e => setMinNonce(Number(e.target.value) || 0)} />

        <button onClick={() => setHideUnactionable(v => !v)}
          className={hideUnactionable ? "toggle-active" : ""}>
          Hide Unactionable: {hideUnactionable ? "On" : "Off"}
        </button>

        <button onClick={loadPending} disabled={loading}>
          {loading ? "Loading..." : "Load Pending"}
        </button>

        <button onClick={selectSignable}>Select Signable</button>
        <button onClick={() => setSelected(new Set())}>Clear</button>
        <button onClick={signSelected} disabled={signing || !selected.size} style={{ borderColor: 'var(--data-green-dim)', color: 'var(--data-green)' }}>
          {signing ? "Signing..." : "▸ Sign Selected"}
        </button>
      </div>

      <div className="row header-line">
        <div>Wallet chain: <span className="mono ok">{CHAIN_NAMES[walletChainId] || walletChainId}</span></div>
        <div>Safe threshold: <span className={`mono ${safeInfo ? "ok" : "muted"}`}>
          {safeInfo?.threshold ?? "unknown"}</span></div>
      </div>

      <div style={{ margin: "10px 0 14px" }}>
        <span className="pill">Visible pending: {visibleTxs.length}</span>
        <span className="pill">All loaded: {txs.length}</span>
        <span className="pill">Min nonce: &gt; {minNonce}</span>
        <span className="pill">Signable: {signableCount}</span>
        <span className="pill">Already signed: {alreadySignedCount}</span>
        <span className="pill">Ready to execute: {thresholdDoneCount}</span>
        <span className="pill">Is owner: {connectedWalletIsOwner() ? "yes" : "no"}</span>
      </div>

      <div>
        {!visibleTxs.length && txs.length > 0 && <div className="muted">No transactions match filters.</div>}
        {!txs.length && <div className="muted">No transactions loaded. Click &quot;Load Pending&quot;.</div>}
        {visibleTxs.map((tx, vi) => {
          const idx = txs.indexOf(tx);
          const signable = isSignable(tx);
          const alreadySigned = hasSigned(tx, address);
          const done = thresholdMet(tx);
          const count = getConfirmCount(tx);
          const required = getRequiredCount(tx);
          const txData = tx.dataDecoded ? JSON.stringify(tx.dataDecoded, null, 2) : (tx.data || "0x");
          const isExecuted = !!tx._executedTxHash;

          let statusText, statusClass;
          if (isExecuted) { statusText = "Execution submitted"; statusClass = "ok"; }
          else if (done) { statusText = "Ready to execute"; statusClass = "ok"; }
          else if (alreadySigned) { statusText = "You already signed"; statusClass = "warn"; }
          else if (!connectedWalletIsOwner()) { statusText = "Not an owner"; statusClass = "bad"; }
          else if (signable) { statusText = "Needs your signature"; statusClass = "ok"; }
          else { statusText = "Not signable"; statusClass = "muted"; }

          return (
            <div className="tx-card" key={tx.safeTxHash || vi} data-status={statusClass}>
              <div className="tx-top">
                <div>
                  <div><strong>Nonce {tx.nonce}</strong></div>
                  <div className={`small ${statusClass}`}>{statusText}</div>
                </div>
                <div className="tx-actions">
                  <label>
                    <input type="checkbox" disabled={!signable && !done}
                      checked={selected.has(idx)}
                      onChange={e => {
                        const next = new Set(selected);
                        e.target.checked ? next.add(idx) : next.delete(idx);
                        setSelected(next);
                      }} />
                    select
                  </label>
                  <button disabled={!signable} onClick={() => signOne(tx, idx)}>Sign</button>
                  {done && !isExecuted && (
                    <button
                      disabled={executing}
                      onClick={() => executeOne(tx, idx)}
                      style={{ borderColor: 'var(--wire-cyan-dim)', color: 'var(--wire-cyan)' }}
                    >
                      {executing ? "Executing..." : "⚡ Execute"}
                    </button>
                  )}
                  {isExecuted && (
                    <span className="small ok">Submitted: {shortAddr(tx._executedTxHash)}</span>
                  )}
                </div>
              </div>

              <div className="small" style={{ marginTop: 8 }}>
                <span className="pill">Confirmations: {count}/{required || "?"}</span>
                <span className="pill">To: {shortAddr(tx.to || "")}</span>
                <span className="pill">Value: {String(tx.value ?? "0")}</span>
                <span className="pill">Operation: {String(tx.operation ?? "")}</span>
              </div>

              <div style={{ marginTop: 10 }}>
                <div className="small muted">Safe Tx Hash</div>
                <div className="mono small">{tx.safeTxHash}</div>
              </div>

              <div style={{ marginTop: 10 }}>
                <div className="small muted">Target</div>
                <div className="mono small">{tx.to || ""}</div>
              </div>

              <div style={{ marginTop: 10 }}>
                <div className="small muted">Data / decoded preview</div>
                <details>
                  <summary className="small">show</summary>
                  <pre className="small mono">{esc(txData)}</pre>
                </details>
              </div>

              {done && !isExecuted && <div className="disabled-note">Threshold met — ready for execution.</div>}
              {alreadySigned && !done && <div className="disabled-note">You already confirmed this transaction.</div>}
              {!connectedWalletIsOwner() && !done && !alreadySigned && <div className="disabled-note">Connected wallet is not in the Safe owner list.</div>}
            </div>
          );
        })}
      </div>

      <div id="log">
        {logs.map(l => (
          <div key={l.id} className={l.cls}>[{l.time}] {l.msg}</div>
        ))}
        {!logs.length && <div className="muted">Logs will appear here...</div>}
      </div>
    </div>
  );
}
