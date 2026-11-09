# Ghost Circuit

Corrida de drones no navegador contra o seu próprio fantasma. Uma pista, quatro checkpoints, tentativas curtas: cada corrida completa vira um drone fantasma translúcido para você disputar na tentativa seguinte.

> "Só mais uma tentativa. Consigo fazer aquela curva melhor."

- 100% no cliente: React + TypeScript + Vite + Three.js, sem backend, login ou serviços pagos.
- Geometria, texturas e sons gerados proceduralmente (nenhum asset externo).
- Recorde, gravações do fantasma e preferências ficam no `localStorage`.

## Modos de jogo

- **Contra o fantasma** (contra o relógio): uma volta contra a sua própria gravação, a última corrida ou o recorde. Cada corrida completa vira um fantasma.
- **Corrida vs IA**: você larga em último contra 3 drones rivais (Vespa, Falcão e Cometa), em 1, 2 ou 3 voltas, e precisa cruzar a chegada em 1º.
  - Os rivais usam a mesma física que você. A dificuldade só muda como eles pilotam: velocidade alvo, agressividade nas curvas, uso de boost e do atalho, e precisão da linha.
  - Os drones colidem entre si. Quem termina a corrida fica translúcido e para de colidir.
  - O HUD mostra posição, volta e avisos de ultrapassagem. A tela final mostra a classificação.
  - Cada pista guarda, por dificuldade e número de voltas, a melhor posição, o melhor tempo e as vitórias. Corridas abandonadas não contam, e corridas contra a IA não geram fantasmas.

| Dificuldade | Rivais (tempo de volta típico) |
| --- | --- |
| Fácil | ~39–46 s, sem boost nem atalho, linha imprecisa |
| Médio | ~32–38 s, sem boost, atalho às vezes |
| Difícil | ~26–32 s, boost limitado, atalho com frequência |
| Insano | ~24–32 s, boost em toda recarga, atalho e curvas no limite da física |

A IA freia de acordo com o limite real do drone: ele mantém a velocidade enquanto gira, então o que limita uma curva é a velocidade de giro, não a aderência. A calibragem usa como referência quem segura acelerador e boost a corrida toda sem frear. Esse estilo vence o Médio e perde para o Insano em todas as pistas (teste em `src/game/raceMode.test.ts`). No Insano, mesmo um piloto tão bom quanto a melhor IA, largando em último, termina cerca de 1 s atrás em 2 voltas. Para vencer, é preciso pilotar melhor que ela.

## Pistas

| Pista | Tema | Origem |
| --- | --- | --- |
| Arena Crepúsculo | entardecer | feita à mão |
| Neon Noturno | noite | seed 16 |
| Duna Solar | deserto | seed 3 |
| Aurora Glacial | amanhecer | seed 30 |
| Vale da Tempestade | tempestade | seed 28 |

Escolha a pista no menu (setas ‹ ›). Cada pista guarda o próprio recorde e os próprios fantasmas.

As pistas geradas vêm de um gerador procedural com seed (`src/game/generator.ts`). Ele cria um circuito fechado com uma reta para o boost, curvas variadas e trechos técnicos, um atalho estreito entre dois checkpoints e obstáculos sempre com espaço para passar. O resultado é **gravado como dados** em `src/game/generatedMaps.ts`, então todo navegador monta exatamente a mesma pista.

Para adicionar uma pista:

```bash
npm run gen:map -- scan 1 50     # avalia seeds: tempo de volta do piloto automático, ganho do atalho, colisões
npm run gen:map -- show 42       # mostra a definição gerada para uma seed
# adicione a seed em scripts/map-seeds.ts (id, nome, tema) e então:
npm run gen:maps                 # regenera src/game/generatedMaps.ts
npm test                         # valida todas as pistas
```

Os testes (`src/game/maps.test.ts`) validam toda pista do catálogo:
- obstáculos dentro da faixa, com espaço para passar e longe das paredes e dos portais;
- portais impossíveis de contornar;
- atalho entre dois checkpoints consecutivos e realmente mais curto;
- volta completa do piloto automático pela linha principal e pelo atalho;
- pistas geradas idênticas ao que a seed produz.

## Como jogar

Escolha a pista e passe pelos **4 checkpoints na ordem** (o próximo portal fica rosa e pulsando; uma seta na borda da tela aponta para ele quando sai do campo de visão) e cruze a **chegada**. Ao terminar, sua trajetória vira um fantasma.

Antes de cada tentativa, escolha o fantasma: **Última corrida** (padrão) ou **Meu recorde**. Em cada checkpoint aparece a diferença de tempo para o fantasma no mesmo ponto (verde = à frente, vermelho = atrás).

Toda pista tem uma reta para o boost, curvas largas, trechos técnicos e um **atalho estreito** (paredes de outra cor e piso com chevrons) entre dois checkpoints: caminho mais curto, entrada fechada e pilares em slalom.

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
npm run gen:map      # ferramentas do gerador de pistas (veja "Pistas")
```

### Teste ponta a ponta

`npm run test:e2e` sobe o `vite preview`, abre o jogo no Chromium (Playwright) com `?test` — que expõe o motor em `window.__ghostCircuit` e permite que um piloto automático dirija — e valida o fluxo completo: abrir e iniciar; completar os 4 checkpoints e a chegada; reiniciar contra o fantasma recém-gravado; bater o recorde e atualizar a gravação certa; recarregar e recuperar os dados; abandonar uma tentativa sem perder gravações; trocar de pista com recordes separados; corrida vs IA (vencer no Fácil, perder no Insano com piloto fraco, resultados por dificuldade, preferências lembradas, corrida abandonada não conta); pausa ao perder o foco; dados corrompidos; controles touch com toques simultâneos em viewport de celular; ausência de erros no console. Capturas de tela vão para `e2e/output/`.

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
    track.ts       pista: formato TrackDef, corredores (SDF), portais, obstáculos
    maps.ts        catálogo de pistas (+ generatedMaps.ts, gerado por seed)
    generator.ts   gerador procedural de pistas por seed
    drone.ts       física arcade em timestep fixo, colisões e inclinação visual
    race.ts        regras: checkpoints em ordem, cruzamento direcional varrido
    ghost.ts       gravação (20 Hz, timestamps da corrida) e reprodução interpolada
    storage.ts     persistência versionada e validada no localStorage
    simulation.ts  uma tentativa: contagem, corredores, voltas, posições, colisões entre drones, gravação, recuperação
    ai.ts          rivais de IA: perfis de dificuldade, ultrapassagem, escolha de rota
    autopilot.ts   seguidor de rota (base da IA e dos testes)
  engine/      loop do jogo, entrada (teclado/touch), áudio sintetizado, HUD
  render/      cena Three.js: ambiente, temas por pista, pista, drones, câmera, partículas
  ui/          React: menus, HUD (estático, atualizado por refs), controles touch
scripts/       ferramentas de pistas (gen-map.ts, map-seeds.ts)
e2e/run.mjs    teste ponta a ponta com Playwright
```

Decisões principais:

- **Timestep fixo** de 120 Hz para a simulação, com interpolação entre os dois últimos estados na renderização. O React só re-renderiza em transições de fase; o HUD é atualizado direto no DOM, e só quando um valor muda.
- **Área jogável como união de "tubos"** de largura variável ao redor de polilinhas (pista principal + atalho). A colisão empurra o drone de volta pela distância com sinal e remove só a componente da velocidade contra a parede — ele desliza e nunca prende. Choques de frente desviam lateralmente. Como rede de segurança, se o drone sair da área (ou ficar parado acelerando por 3 s), ele volta ao último ponto seguro.
- **Checkpoints** são segmentos com direção. Cada passo testa o segmento entre a posição anterior e a atual (funciona em qualquer velocidade), exige o lado de trás → frente e só aceita o *próximo* portal esperado. Pular checkpoints, passar ao contrário ou ficar parado dentro do portal não conta. Os tempos de passagem são interpolados dentro do passo e arredondados ao milissegundo.
- **Fantasma**: amostras `[t, x, y, z, yaw, pitch, roll]` a 20 Hz, mais uma amostra exata na chegada. A reprodução usa busca binária no tempo da corrida, Catmull-Rom na posição e interpolação pelo arco mais curto nos ângulos. A gravação usada numa tentativa é fixa durante a corrida. Limite de 5 min (6000 amostras).
- **Pistas como dados**: checkpoints e obstáculos são posicionados pela distância ao longo da pista e pelo deslocamento lateral, não por coordenadas absolutas. Assim continuam no lugar certo quando o traçado muda.
- **Persistência**: uma chave por pista (`ghostcircuit:runs:<id>` para fantasmas e `ghostcircuit:race:<id>` para resultados contra a IA), com versão de formato e `pista@versão`.
- **Desempenho**: a distância até as paredes usa uma grade espacial por corredor, com resultado idêntico à busca completa. Assim, simular 4 drones a 120 Hz continua leve no celular. Gravações de outra versão da pista são descartadas; tudo é validado ao ler. Quando o recorde e a última corrida são a mesma gravação, ela é salva uma vez só. Se a cota estourar, guarda pelo menos o recorde. Sem `localStorage`, o jogo funciona normalmente e avisa que nada será salvo.
- **Desempenho**: objetos instanciados (paredes, torres), sem sombras em tempo real (sombra "blob"), resolução adaptativa conforme o FPS, menos decoração e pixel ratio menor em celulares.

## Limitações conhecidas

- Alterar o traçado de uma pista exige incrementar a `version` dela, o que descarta os fantasmas salvos daquela pista. A Arena Crepúsculo passou para a v2 nesta atualização (obstáculos corrigidos), então recordes antigos dela foram descartados.
- Corridas acima de 5 minutos contam o tempo, mas não são gravadas como fantasma.
- O áudio só começa depois da primeira interação (exigência dos navegadores).
- Os testes automatizados rodaram em Chromium com renderização por software; desempenho real em GPUs e celulares físicos não foi medido.
