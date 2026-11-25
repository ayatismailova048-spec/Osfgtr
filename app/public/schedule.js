// Расписание: единый источник для сервера и страницы.
const NAMES=["Хамдия","Ханифа","Хаммад","Аят"];
const DEFHUE=[215,330,32,125];
const HUES=[215,330,32,125,265,185,0,55];
const TASKS={
  dishAM:["Мытьё посуды до обеда",3], dishPM:["Мытьё посуды после обеда",3], trash:["Выброс мусора",1],
  water:["Принести воды",2], vac:["Пылесос",2], cat:["Уход за кошкой",1], table:["Уборка стола и столешниц на кухне",2], stove:["Мытьё плиты",2],
  sink:["Мытьё раковин, туалета, зеркал, сантехники",3], laundry:["Развешивание белья и глажка",1],
  room:["Уборка в своей комнате",2], cook:["Готовка еды и хлеб",3], fridge:["Мытьё холодильника, уборка поверхностей",2]};
const ORDER=["dishAM","dishPM","cook","trash","water","cat","table","stove","room","sink","laundry","fridge","vac"];
const FREQ={dishAM:["1 человек","каждый день"],dishPM:["1 человек","каждый день"],cook:["1 человек","каждый день"],
  trash:["2 человека вместе","каждый день"],water:["2 человека вместе","через день"],cat:["1 человек","каждый день"],
  table:["1 человек","каждый день"],stove:["1 человек","каждый день"],room:["2 человека (каждый свою комнату)","каждый день"],
  sink:["1 человек","раз в 4 дня"],laundry:["1 человек","раз в 4 дня"],fridge:["1 человек","раз в 4 дня"],vac:["1 человек","раз в 4 дня"]};
// Срок выполнения (час дня), после которого невыполненное задание считается просроченным
const DEADLINE={dishAM:13};
const DEFAULT_DEADLINE=20;
// Цикл из 4 дней. В каждом дне 4 набора по 6 баллов. Набор переходит к следующему человеку каждый день.
const CYCLE=[
 [['dishAM','cook'],['dishPM','sink'],['stove','room','trash','laundry'],['table','room','trash','cat']],
 [['dishAM','cook'],['dishPM','water','trash'],['table','stove','fridge'],['water','room','trash','cat']],
 [['dishAM','cook'],['dishPM','room','trash'],['table','stove','room'],['vac','room','trash','cat']],
 [['dishAM','cook'],['dishPM','water','trash'],['table','stove','room'],['water','room','trash','cat']]];
const DAYS=["Понедельник","Вторник","Среда","Четверг","Пятница","Суббота","Воскресенье"];
const SHORT=["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
const MONTHS=["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const REF=new Date(2026,10,16);

const iso=d=>d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
const addDays=(d,n)=>new Date(d.getFullYear(),d.getMonth(),d.getDate()+n);
const dow=d=>(d.getDay()+6)%7;
const monday=d=>addDays(d,-dow(d));
const dayN=d=>Math.round((d-REF)/864e5);
const fmt=d=>d.getDate()+" "+MONTHS[d.getMonth()];
function assign(d){
  const n=dayN(d),c=Math.floor(n/4),day=CYCLE[((n%4)+4)%4];
  return NAMES.map((_,p)=>day[(((p-n-c)%4)+4)%4]);
}
const sumPts=l=>l.reduce((a,k)=>a+TASKS[k][1],0);
const key=(d,p,t)=>iso(d)+"_"+p+"_"+t;
if(typeof module!=="undefined")module.exports={NAMES,DEFHUE,HUES,TASKS,ORDER,FREQ,DEADLINE,DEFAULT_DEADLINE,CYCLE,DAYS,SHORT,MONTHS,REF,iso,addDays,dow,monday,dayN,fmt,assign,sumPts,key};
