# Ghost Circuit

Corrida de drones no navegador contra o seu próprio fantasma. Uma pista, quatro checkpoints, tentativas curtas: cada corrida completa vira um drone fantasma translúcido para você disputar na tentativa seguinte.

> "Só mais uma tentativa. Consigo fazer aquela curva melhor."

- 100% no cliente: React + TypeScript + Vite + Three.js, sem backend, login ou serviços pagos.
- Geometria, texturas e sons gerados proceduralmente (nenhum asset externo).
- Recorde, gravações do fantasma e preferências ficam no `localStorage`.

## Como jogar

Passe pelos **4 checkpoints na ordem** (o próximo portal fica rosa e pulsando; uma seta na borda da tela aponta para ele quando sai do campo de visão) e cruze a **chegada**. Ao terminar, sua trajetória vira um fantasma.

Antes de cada tentativa, escolha o fantasma: **Última corrida** (padrão) ou **Meu recorde**. Em cada checkpoint aparece a diferença de tempo para o fantasma no mesmo ponto (verde = à frente, vermelho = atrás).

A pista tem uma reta longa para o boost, curvas largas, uma chicane técnica e um **atalho estreito** (paredes âmbar) entre o CP 1 e o CP 2: caminho mais curto, entrada fechada e pilares no meio.

### Controles

| Ação | Teclado | Celular |
| --- | --- | --- |
| Acelerar | `W` / `↑` | botão **Acelerar** (direita) |
| Frear / ré | `S` / `↓` | botão **Frear** |
| Virar | `A` `D` / `←` `→` | arrastar o controle virtual (esquerda) |
| Boost (barra recarregável) | `Espaço` | botão **Boost** |
| Reiniciar tentativa | `R` | pausa → Reiniciar |
| Pausar | `Esc` (ou `P`) | botão ❚❚ |
| Silenciar | `M` | botão 🔊 |
| Tentar novamente (tela final) | `Enter` ou `R` | botão **Tentar novamente** |

O jogo pausa sozinho ao perder o foco (troca de aba/janela) e solta todos os controles.

## Comandos

Requer Node.js 20+ (testado com Node 22).

```bash
npm install          # instalar dependências
npm run dev          # servidor de desenvolvimento (http://localhost:5173)
npm run typecheck    # verificação de tipos (tsc -b)
npm test             # testes unitários (Vitest)
npm run build        # typecheck + build estático em dist/
npm run preview      # servir o build localmente (http://localhost:4173)
npm run test:e2e     # teste ponta a ponta no navegador (requer `npm run build` antes)
```

### Teste ponta a ponta

`npm run test:e2e` sobe o `vite preview`, abre o jogo no Chromium (Playwright) com `?test` — que expõe o motor em `window.__ghostCircuit` e permite que um piloto automático dirija — e valida o fluxo completo: abrir e iniciar; completar os 4 checkpoints e a chegada; reiniciar contra o fantasma recém-gravado; bater o recorde e atualizar a gravação certa; recarregar e recuperar os dados; abandonar uma tentativa sem perder gravações; pausa ao perder o foco; dados corrompidos; controles touch com toques simultâneos em viewport de celular; ausência de erros no console. Capturas de tela vão para `e2e/output/`.

Se o Chromium do Playwright não estiver instalado na sua máquina: `npx playwright install chromium`.

Variáveis opcionais: `E2E_URL` (usar um servidor já rodando), `E2E_SPEED` (multiplicador de velocidade da simulação, padrão 4), `E2E_HEADED=1`.

## Deploy na Vercel

O projeto gera um build estático (`dist/`) e já inclui `vercel.json` (framework Vite, `npm run build`, saída `dist`, cache longo para `/assets`).

**Pelo painel:**
1. Em [vercel.com/new](https://vercel.com/new), importe o repositório do GitHub.
2. A Vercel detecta Vite automaticamente; mantenha *Build Command* `npm run build` e *Output Directory* `dist`.
3. Clique em **Deploy**. Cada push gera uma URL de preview; a branch padrão vai para produção.

**Pela CLI:**
```bash
npm i -g vercel
vercel          # deploy de preview
vercel --prod   # produção
```

Não há variáveis de ambiente nem backend para configurar.

## Arquitetura

```
src/
  game/        simulação pura (sem DOM/Three), testada com Vitest
    track.ts       pista: corredores (SDF), portais, obstáculos, versão da pista
    drone.ts       física arcade em timestep fixo, colisões e inclinação visual
    race.ts        regras: checkpoints em ordem, cruzamento direcional varrido
    ghost.ts       gravação (20 Hz, timestamps da corrida) e reprodução interpolada
    storage.ts     persistência versionada e validada no localStorage
    simulation.ts  uma tentativa: contagem, corrida, gravação, recuperação
    autopilot.ts   piloto automático usado só nos testes
  engine/      loop do jogo, entrada (teclado/touch), áudio sintetizado, HUD
  render/      cena Three.js: ambiente, pista, drones, câmera, partículas
  ui/          React: menus, HUD (estático, atualizado por refs), controles touch
e2e/run.mjs    teste ponta a ponta com Playwright
```

Decisões principais:

- **Timestep fixo** de 120 Hz para a simulação, com interpolação entre os dois últimos estados na renderização. O React só re-renderiza em transições de fase; o HUD é atualizado direto no DOM, e só quando um valor muda.
- **Área jogável como união de "tubos"** de largura variável ao redor de polilinhas (pista principal + atalho). A colisão empurra o drone de volta pela distância com sinal e remove só a componente da velocidade contra a parede — ele desliza e nunca prende. Choques de frente desviam lateralmente. Como rede de segurança, se o drone sair da área (ou ficar parado acelerando por 3 s), ele volta ao último ponto seguro.
- **Checkpoints** são segmentos com direção. Cada passo testa o segmento entre a posição anterior e a atual (funciona em qualquer velocidade), exige o lado de trás → frente e só aceita o *próximo* portal esperado. Pular checkpoints, passar ao contrário ou ficar parado dentro do portal não conta. Os tempos de passagem são interpolados dentro do passo e arredondados ao milissegundo.
- **Fantasma**: amostras `[t, x, y, z, yaw, pitch, roll]` a 20 Hz, mais uma amostra exata na chegada. A reprodução usa busca binária no tempo da corrida, Catmull-Rom na posição e interpolação pelo arco mais curto nos ângulos. A gravação usada numa tentativa é fixa durante a corrida. Limite de 5 min (6000 amostras).
- **Persistência**: chave `ghostcircuit:runs` com versão de formato e `pista@versão`. Gravações de outra versão da pista são descartadas; tudo é validado ao ler. Quando o recorde e a última corrida são a mesma gravação, ela é salva uma vez só. Se a cota estourar, guarda pelo menos o recorde. Sem `localStorage`, o jogo funciona normalmente e avisa que nada será salvo.
- **Desempenho**: objetos instanciados (paredes, torres), sem sombras em tempo real (sombra "blob"), resolução adaptativa conforme o FPS, menos decoração e pixel ratio menor em celulares.

## Limitações conhecidas

- Uma única pista; alterar o traçado exige incrementar `TRACK_VERSION` (o que descarta fantasmas salvos).
- Corridas acima de 5 minutos contam o tempo, mas não são gravadas como fantasma.
- O áudio só começa depois da primeira interação (exigência dos navegadores).
- Os testes automatizados rodaram em Chromium com renderização por software; desempenho real em GPUs e celulares físicos não foi medido.
