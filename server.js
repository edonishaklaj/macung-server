const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

// ── EMAIL SETUP (optional) ───────────────────────────────────────────────────
let transporter = null;
try{
  const nodemailer = require("nodemailer");
  if(process.env.EMAIL_USER && process.env.EMAIL_PASS){
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
  }
}catch(e){ console.log("nodemailer not available"); }

app.post("/send-welcome", async(req,res)=>{
  const {name, email} = req.body;
  if(!transporter||!email||!name){ res.json({ok:false}); return; }
  try{
    await transporter.sendMail({
      from: `"Maçung 🃏" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Mirë se vjen në Maçung! 🃏",
      html: `
        <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;background:#0a0000;color:#e8d5d5;padding:30px;border-radius:12px;">
          <h1 style="color:#ff4444;text-align:center;letter-spacing:3px;">♠ MAÇUNG ♠</h1>
          <p style="font-size:18px;color:#ffd700;">Mirë se vjen, ${name}! 🎉</p>
          <p style="color:#c08080;">Accounts yt u krijua me sukses. Tani mund të luash online me miqtë!</p>
          <div style="background:rgba(255,68,68,0.1);border:1px solid #ff444444;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="margin:0;color:#888;font-size:13px;">Email i regjistrimit:</p>
            <p style="margin:4px 0 0;color:#ff4444;font-weight:700;">${email}</p>
          </div>
          <p style="color:#666;font-size:12px;text-align:center;">Loja: <a href="https://macung.vercel.app" style="color:#ff4444;">macung.vercel.app</a></p>
        </div>
      `,
    });
    res.json({ok:true});
  }catch(e){
    console.error("Email error:",e.message);
    res.json({ok:false});
  }
});

const rooms = {};

function makeCode(){
  return Math.random().toString(36).substring(2,6).toUpperCase();
}

function getRoomBySocket(sid){
  return Object.values(rooms).find(r=>
    r.players.some(p=>p.id===sid)||r.pending.some(p=>p.id===sid)
  );
}

const SUITS=["♠","♥","♦","♣"];
const VALUES=["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function createDeck(){
  const d=[];
  for(let c=0;c<2;c++){
    for(const s of SUITS) for(const v of VALUES)
      d.push({id:`${v}${s}_${c}`,value:v,suit:s,isJoker:false});
    d.push({id:`JK_${c}`,value:"★",suit:"★",isJoker:true});
  }
  return shuffle(d);
}

function shuffle(a){
  const b=[...a];
  for(let i=b.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [b[i],b[j]]=[b[j],b[i]];
  }
  return b;
}

// Clockwise next seat: 0→3→2→1→0
function nextSeat(cur, activeSet){
  for(let i=1;i<=4;i++){
    const s=(cur+4-i)%4;
    if(activeSet.has(s)) return s;
  }
  return cur;
}

const TABLES=[
  {id:1,surrender:0.5,kent:1,macung:2},
  {id:2,surrender:1,kent:2,macung:5},
  {id:3,surrender:2,kent:5,macung:10},
  {id:4,surrender:5,kent:10,macung:20},
  {id:5,surrender:10,kent:20,macung:50},
];

function newRoom(tableId){
  return {
    tableId,
    players:[],
    pending:[],
    deck:[],discard:[],
    playerDiscards:{0:[],1:[],2:[],3:[]},
    current:0,dealer:0,
    phase:"waiting",hasDrawn:false,
    roundNum:1,
    scores:{0:0,1:0,2:0,3:0},
    started:false,
  };
}

function roomInfo(code){
  const r=rooms[code];
  return {
    code,
    tableId:r.tableId,
    started:r.started,
    players:r.players.map(p=>({seat:p.seat,name:p.name,cardCount:p.hand.length})),
    pending:r.pending.map(p=>({seat:p.seat,name:p.name})),
  };
}

function broadcast(code){
  const r=rooms[code];
  const state={
    code,
    tableId:r.tableId,
    current:r.current,
    dealer:r.dealer,
    phase:r.phase,
    hasDrawn:r.hasDrawn,
    roundNum:r.roundNum,
    scores:r.scores,
    discard:r.discard,
    playerDiscards:r.playerDiscards,
    deckCount:r.deck.length,
    players:r.players.map(p=>({seat:p.seat,name:p.name,cardCount:p.hand.length})),
    playerCount:r.players.length,
  };
  io.to(code).emit("gameUpdate",state);
  r.players.forEach(p=>io.to(p.id).emit("yourHand",{hand:p.hand}));
}

function dealRound(code){
  const r=rooms[code];
  r.started=true;
  r.deck=createDeck();
  r.discard=[];
  r.playerDiscards={0:[],1:[],2:[],3:[]};
  r.hasDrawn=true;
  r.players.forEach(p=>{p.hand=[];});

  const ds=r.dealer;
  [...r.players].sort((a,b)=>a.seat-b.seat).forEach(p=>{
    const n=p.seat===ds?15:14;
    for(let i=0;i<n;i++) p.hand.push(r.deck.shift());
  });

  // Dealer starts with 15 cards and must discard first
  r.phase="discard";
  r.current=ds;

  broadcast(code);
}

io.on("connection",(socket)=>{
  console.log("Connected:",socket.id);

  socket.on("createRoom",({playerName,tableId},cb)=>{
    const code=makeCode();
    rooms[code]=newRoom(tableId);
    rooms[code].code=code;
    rooms[code].players.push({id:socket.id,name:playerName,seat:0,hand:[]});
    socket.join(code);
    cb({code,seat:0,pending:false});
    io.to(code).emit("roomUpdate",roomInfo(code));
  });

  socket.on("joinRoom",({playerName,code},cb)=>{
    const r=rooms[code];
    if(!r){cb({error:"Dhoma nuk ekziston"});return;}
    const total=r.players.length+r.pending.length;
    if(total>=4){cb({error:"Dhoma është e plotë"});return;}

    const taken=[...r.players,...r.pending].map(p=>p.seat);
    const seat=[0,1,2,3].find(s=>!taken.includes(s));

    if(r.started){
      r.pending.push({id:socket.id,name:playerName,seat,hand:[]});
      socket.join(code);
      cb({code,seat,pending:true});
      socket.emit("waitingForRound",{message:"⏳ Duke pritur fundin e raundeve..."});
    } else {
      r.players.push({id:socket.id,name:playerName,seat,hand:[]});
      socket.join(code);
      cb({code,seat,pending:false});
    }
    io.to(code).emit("roomUpdate",roomInfo(code));
  });

  socket.on("findRoom",({playerName,tableId},cb)=>{
    const open=Object.values(rooms).find(r=>
      !r.started&&r.tableId===tableId&&(r.players.length+r.pending.length)<4
    );
    if(open){
      const taken=open.players.map(p=>p.seat);
      const seat=[0,1,2,3].find(s=>!taken.includes(s));
      open.players.push({id:socket.id,name:playerName,seat,hand:[]});
      socket.join(open.code);
      cb({code:open.code,seat,pending:false});
      io.to(open.code).emit("roomUpdate",roomInfo(open.code));
    } else {
      const code=makeCode();
      rooms[code]=newRoom(tableId);
      rooms[code].code=code;
      rooms[code].players.push({id:socket.id,name:playerName,seat:0,hand:[]});
      socket.join(code);
      cb({code,seat:0,pending:false});
      io.to(code).emit("roomUpdate",roomInfo(code));
    }
  });

  socket.on("startGame",({code})=>{
    const r=rooms[code];
    if(!r) return;
    const p=r.players.find(p=>p.id===socket.id);
    if(!p||p.seat!==0) return;
    if(r.players.length<2){socket.emit("error","Duhen të paktën 2 lojtarë");return;}
    dealRound(code);
  });

  socket.on("drawDeck",({code})=>{
    const r=rooms[code];
    if(!r||!r.started) return;
    const p=r.players.find(p=>p.id===socket.id);
    if(!p||r.current!==p.seat||r.phase!=="draw"||r.hasDrawn) return;
    if(r.deck.length===0){
      if(r.discard.length<=1) return;
      const top=r.discard.pop();r.deck=shuffle(r.discard);r.discard=[top];
    }
    const card=r.deck.shift();
    p.hand.push(card);
    r.hasDrawn=true;r.phase="discard";
    broadcast(code);
  });

  socket.on("drawDiscard",({code})=>{
    const r=rooms[code];
    if(!r||!r.started) return;
    const p=r.players.find(p=>p.id===socket.id);
    if(!p||r.current!==p.seat||r.phase!=="draw"||r.hasDrawn||r.discard.length===0) return;
    const card=r.discard.pop();
    p.hand.push(card);
    r.playerDiscards[p.seat]=r.playerDiscards[p.seat].filter(c=>c.id!==card.id);
    r.hasDrawn=true;r.phase="discard";
    broadcast(code);
  });

  socket.on("discardCard",({code,cardIdx,cardId})=>{
    const r=rooms[code];
    if(!r||!r.started) return;
    const p=r.players.find(p=>p.id===socket.id);
    if(!p||r.current!==p.seat||r.phase!=="discard") return;
    // Find by cardId first (more reliable), fallback to cardIdx
    let card;
    if(cardId){
      const idx=p.hand.findIndex(c=>c.id===cardId);
      if(idx===-1) return;
      card=p.hand.splice(idx,1)[0];
    } else {
      card=p.hand.splice(cardIdx,1)[0];
    }
    if(!card) return;
    // STRICT: never allow Joker discard
    if(card.isJoker){
      p.hand.push(card); // put it back
      return;
    }
    r.discard.push(card);
    r.playerDiscards[p.seat].push(card);
    const active=new Set(r.players.map(x=>x.seat));
    r.current=nextSeat(r.current,active);
    r.phase="draw";r.hasDrawn=false;
    broadcast(code);
  });

  socket.on("finishGame",({code,type,localHand})=>{
    const r=rooms[code];
    if(!r||!r.started) return;
    const p=r.players.find(p=>p.id===socket.id);
    if(!p) return;
    const table=TABLES.find(t=>t.id===r.tableId)||TABLES[0];
    const val=type==="macung"?table.macung:table.kent;
    const n=r.players.length;
    r.players.forEach(x=>{
      if(x.seat===p.seat) r.scores[x.seat]-=(val*(n-1));
      else r.scores[x.seat]+=val;
    });
    io.to(code).emit("gameFinished",{
      type,winner:p.seat,val,
      winnerName:p.name,
      winnerHand: localHand && localHand.length>0 ? localHand : p.hand,
      scores:r.scores,
      playerCount:n,
    });
  });

  socket.on("newRound",({code})=>{
    const r=rooms[code];
    if(!r) return;
    // Deduplicate: ignore if round already started recently
    if(r.roundStarting) return;
    r.roundStarting=true;
    setTimeout(()=>{ if(r) r.roundStarting=false; },3000);

    // Merge pending into active
    if(r.pending.length>0){
      r.pending.forEach(p=>r.players.push(p));
      r.pending=[];
    }
    const active=new Set(r.players.map(p=>p.seat));
    // Clockwise rotation: 0→3→2→1→0
    r.dealer=(r.dealer+3)%4;
    while(!active.has(r.dealer)) r.dealer=(r.dealer+3)%4;
    r.roundNum++;
    io.to(code).emit("roomUpdate",roomInfo(code));
    dealRound(code);
  });

  socket.on("disconnect",()=>{
    const r=getRoomBySocket(socket.id);
    if(!r) return;
    r.players=r.players.filter(p=>p.id!==socket.id);
    r.pending=r.pending.filter(p=>p.id!==socket.id);
    if(r.players.length===0&&r.pending.length===0){
      delete rooms[r.code];
    } else {
      io.to(r.code).emit("playerLeft",{name:"Lojtari"});
      io.to(r.code).emit("roomUpdate",roomInfo(r.code));
      if(r.started&&r.players.length<2)
        io.to(r.code).emit("gamePaused",{message:"⚠️ Lojtarë të pamjaftueshëm"});
    }
    console.log("Disconnected:",socket.id);
  });
});

const PORT=process.env.PORT||3001;
server.listen(PORT,()=>console.log(`Macung server on port ${PORT}`));
