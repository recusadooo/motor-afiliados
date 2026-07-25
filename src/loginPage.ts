/**
 * Página de login — HTML inline, sem arquivo estático, porque tudo que é
 * estático fica atrás do porteiro. Mesma identidade do painel (escuro
 * industrial, âmbar de sinal), reduzida ao essencial.
 */
export function paginaLogin(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Entrar — MOTOR::AFILIADO</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{--void:#0E1116;--panel:#161B22;--panel2:#1B222B;--line:#2A333F;--ink:#E9EFF5;--ink3:#7C8896;
    --signal:#F5A524;--danger:#F0503A}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:var(--void);color:var(--ink);display:grid;place-items:center;
    font-family:"IBM Plex Sans",system-ui,sans-serif;padding:24px}
  .caixa{width:100%;max-width:380px}
  .marca{font-family:"IBM Plex Mono",monospace;font-size:12px;letter-spacing:.12em;color:var(--ink3);
    display:flex;align-items:center;gap:9px;margin-bottom:22px}
  .led{width:9px;height:9px;border-radius:50%;background:var(--signal);box-shadow:0 0 10px rgba(245,165,36,.7)}
  h1{font-family:"Bricolage Grotesque","IBM Plex Sans",sans-serif;font-weight:800;font-size:30px;
    letter-spacing:-.02em;margin:0 0 6px}
  p.sub{color:var(--ink3);font-size:13.5px;margin:0 0 22px}
  form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px}
  label{display:block;font-family:"IBM Plex Mono",monospace;font-size:10.5px;letter-spacing:.06em;
    text-transform:uppercase;color:var(--ink3);margin:0 0 6px}
  input{width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--ink);
    font-family:inherit;font-size:15px;padding:11px 12px;margin-bottom:14px}
  input:focus{outline:none;border-color:var(--signal)}
  button{width:100%;font-family:"IBM Plex Mono",monospace;font-size:13px;font-weight:600;border:0;
    border-radius:8px;padding:12px;background:var(--signal);color:#1a1206;cursor:pointer}
  button:disabled{opacity:.6;cursor:progress}
  .erro{color:#ff8a76;font-family:"IBM Plex Mono",monospace;font-size:12px;margin-top:12px;min-height:16px}
  .dica{color:var(--ink3);font-size:12px;margin-top:16px;line-height:1.5}
  :focus-visible{outline:2px solid var(--signal);outline-offset:2px}
</style>
</head>
<body>
  <div class="caixa">
    <div class="marca"><span class="led"></span>MOTOR::AFILIADO</div>
    <h1>Entrar</h1>
    <p class="sub">Painel de operação. Acesso restrito ao dono.</p>
    <form id="f" autocomplete="on">
      <label for="usuario">Usuário</label>
      <input id="usuario" name="usuario" autocomplete="username" required autofocus />
      <label for="senha">Senha</label>
      <input id="senha" name="senha" type="password" autocomplete="current-password" required />
      <button id="b" type="submit">Entrar</button>
      <div class="erro" id="erro"></div>
    </form>
    <p class="dica">Primeira vez? A senha inicial foi gerada no primeiro boot e aparece
      <b>uma única vez</b> no log do container (<span style="font-family:monospace">ACESSO AO PAINEL</span>).
      Troque depois em Config.</p>
  </div>
<script>
const f=document.getElementById('f'),b=document.getElementById('b'),erro=document.getElementById('erro');
f.addEventListener('submit',async ev=>{
  ev.preventDefault();b.disabled=true;erro.textContent='';
  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({usuario:document.getElementById('usuario').value,
                           senha:document.getElementById('senha').value})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.error||('HTTP '+r.status));
    location.href='/';
  }catch(e){erro.textContent=e.message;b.disabled=false;}
});
</script>
</body>
</html>`;
}
