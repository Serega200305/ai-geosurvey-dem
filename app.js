const $ = id => document.getElementById(id);
const demFile = $('demFile');
const canvas = $('demCanvas');
const ctx = canvas.getContext('2d');
const statusEl = $('status');
let dem = null;
let currentMode = 'elevation';
let objectImage = null;
let objectModel = null;

demFile.addEventListener('change', async () => {
  const file = demFile.files?.[0];
  if (!file) return;
  try {
    statusEl.textContent = 'Читаю GeoTIFF...';
    const tiff = await GeoTIFF.fromArrayBuffer(await file.arrayBuffer());
    const image = await tiff.getImage();
    const rasters = await image.readRasters({ samples: [0], interleave: true });
    const width = image.getWidth(), height = image.getHeight();
    const values = Float64Array.from(rasters);
    const nodata = image.getGDALNoData();
    const tie = image.getTiePoints()?.[0] || null;
    const dir = image.getFileDirectory?.() || {};
    const scale = dir.ModelPixelScale || null;
    const geoKeys = image.getGeoKeys?.() || {};
    const epsg = geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey || null;
    const bbox = image.getBoundingBox?.() || null;

    let min = Infinity, max = -Infinity, sum = 0, count = 0;
    for (const v of values) {
      if (Number.isFinite(v) && (nodata === null || nodata === undefined || v !== nodata)) {
        min = Math.min(min, v); max = Math.max(max, v); sum += v; count++;
      }
    }
    if (!count) throw new Error('В растре не найдено корректных значений высоты.');

    const isGeographic = [4326, 4269, 4258, 4283, 4490].includes(Number(epsg)) ||
      (geoKeys.GeographicTypeGeoKey && !geoKeys.ProjectedCSTypeGeoKey);
    let latitude = null;
    if (isGeographic) {
      if (bbox && bbox.length >= 4) latitude = (bbox[1] + bbox[3]) / 2;
      else if (tie) latitude = tie.y;
    }
    let pixelX = scale?.[0] ? Math.abs(scale[0]) : null;
    let pixelY = scale?.[1] ? Math.abs(scale[1]) : null;
    if ((!pixelX || !pixelY) && bbox) {
      pixelX = pixelX || Math.abs(bbox[2] - bbox[0]) / width;
      pixelY = pixelY || Math.abs(bbox[3] - bbox[1]) / height;
    }

    let spacingX = pixelX, spacingY = pixelY, unitLabel = 'не определены';
    if (isGeographic && latitude !== null && pixelX && pixelY) {
      const rad = latitude * Math.PI / 180;
      spacingX = pixelX * 111320 * Math.cos(rad);
      spacingY = pixelY * 110574;
      unitLabel = 'метры (приближённо, локально по широте)';
    } else if (epsg && Number(epsg) >= 2000 && Number(epsg) !== 4326 && pixelX && pixelY) {
      spacingX = pixelX; spacingY = pixelY;
      unitLabel = 'единицы проекции (предполагаются метры)';
    } else {
      spacingX = pixelX || 1; spacingY = pixelY || 1;
      unitLabel = 'масштаб пикселя / единицы исходного растра';
    }

    dem = {width,height,values,nodata,min,max,mean:sum/count,count,bbox,tie,scale,epsg,isGeographic,latitude,spacingX,spacingY,unitLabel};
    canvas.width = width; canvas.height = height;
    $('demInfo').textContent = `${file.name} · ${width} × ${height} ячеек · ${epsg ? 'EPSG:'+epsg : 'EPSG не определён'}`;
    $('minZ').textContent = min.toFixed(2);
    $('maxZ').textContent = max.toFixed(2);
    $('meanZ').textContent = dem.mean.toFixed(2);
    $('rangeZ').textContent = (max-min).toFixed(2);
    $('rasterSize').textContent = `${width} × ${height}`;
    $('validCells').textContent = count.toLocaleString('ru-RU');
    ['showElevation','showSlope','showAspect','showHillshade','downloadPng','downloadStats'].forEach(id=>$(id).disabled=false);
    $('crsInfo').textContent = `Система координат: ${epsg ? 'EPSG:'+epsg : 'не определена'}. Размер ячейки: ${spacingX.toFixed(3)} × ${spacingY.toFixed(3)} ${unitLabel}.`;
    $('hintInfo').textContent = isGeographic
      ? `Для EPSG:${epsg} расстояния переведены из градусов в метры с учётом средней широты ${latitude.toFixed(4)}°. Это локальное приближение; для точной инженерной работы перепроецируйте DEM в подходящую метрическую систему координат.`
      : (epsg ? 'Для проецированной системы координат использованы значения размера пикселя из GeoTIFF. Проверьте единицы измерения высот и координат.' : 'EPSG не удалось определить. Расчёт уклонов может быть условным: проверьте систему координат исходного GeoTIFF.');
    render('elevation');
    statusEl.textContent = 'DEM загружена. Выберите способ визуализации.';
  } catch (e) {
    console.error(e);
    statusEl.textContent = 'Ошибка чтения GeoTIFF: ' + e.message;
  }
});

function isValid(v) {
  return Number.isFinite(v) && (dem.nodata === null || dem.nodata === undefined || v !== dem.nodata);
}
function sample(x,y) {
  if (x<0||y<0||x>=dem.width||y>=dem.height) return null;
  const v=dem.values[y*dem.width+x];
  return isValid(v)?v:null;
}
function derivatives(x,y) {
  const left=sample(x-1,y), right=sample(x+1,y);
  const up=sample(x,y-1), down=sample(x,y+1), center=sample(x,y);
  const dx=Math.max(dem.spacingX,1e-9), dy=Math.max(dem.spacingY,1e-9);
  const dzdx = left!==null&&right!==null ? (right-left)/(2*dx) :
    right!==null&&center!==null ? (right-center)/dx :
    left!==null&&center!==null ? (center-left)/dx : 0;
  const dzdy = up!==null&&down!==null ? (down-up)/(2*dy) :
    down!==null&&center!==null ? (down-center)/dy :
    up!==null&&center!==null ? (center-up)/dy : 0;
  return {dzdx,dzdy};
}
function colorRamp(t) {
  t=Math.max(0,Math.min(1,t));
  const stops=[[0,[35,75,130]],[.25,[55,145,160]],[.5,[105,170,105]],[.75,[205,185,100]],[1,[155,85,55]]];
  let i=0; while(i<stops.length-2&&t>stops[i+1][0])i++;
  const [a,ca]=stops[i], [b,cb]=stops[i+1], q=(t-a)/(b-a);
  return ca.map((v,k)=>Math.round(v+(cb[k]-v)*q));
}
function render(mode) {
  if(!dem)return;
  currentMode=mode;
  const out=ctx.createImageData(dem.width,dem.height);
  const az = Number($('azimuth').value) * Math.PI / 180;
  const alt = Number($('sunAltitude').value) * Math.PI / 180;
  const contrast = Number($('shadeContrast').value) / 100;
  const lightX = Math.sin(az) * Math.cos(alt);
  const lightY = -Math.cos(az) * Math.cos(alt);
  const lightZ = Math.sin(alt);
  for(let y=0;y<dem.height;y++)for(let x=0;x<dem.width;x++){
    const idx=y*dem.width+x, z=sample(x,y), o=idx*4;
    if(z===null){out.data[o]=225;out.data[o+1]=230;out.data[o+2]=232;out.data[o+3]=255;continue;}
    let rgb;
    if(mode==='elevation') rgb=colorRamp((z-dem.min)/(dem.max-dem.min||1));
    else {
      const {dzdx,dzdy}=derivatives(x,y);
      if(mode==='slope'){
        const deg=Math.atan(Math.hypot(dzdx,dzdy))*180/Math.PI;
        rgb=colorRamp(Math.min(deg,60)/60);
      } else if(mode==='aspect'){
        let a=Math.atan2(-dzdx,-dzdy)*180/Math.PI;
        if(a<0)a+=360;
        rgb=colorRamp(a/360);
      } else {
        const nx=-dzdx, ny=-dzdy, nz=1;
        const len=Math.hypot(nx,ny,nz);
        const dot=(nx*lightX+ny*lightY+nz*lightZ)/len;
        const shade=Math.max(0,Math.min(1,0.5 + (dot-0.5)*contrast*1.8));
        const base=colorRamp((z-dem.min)/(dem.max-dem.min||1));
        rgb=base.map(v=>Math.round(v*shade));
      }
    }
    out.data[o]=rgb[0];out.data[o+1]=rgb[1];out.data[o+2]=rgb[2];out.data[o+3]=255;
  }
  ctx.putImageData(out,0,0);
  const labels={elevation:'Карта высот',slope:'Уклон (градусы; расстояния в метрах)',aspect:'Экспозиция (направление склона)',hillshade:'Hillshade (настраиваемая отмывка)'};
  $('legend').textContent=labels[mode]+(mode==='hillshade'?' · азимут '+$('azimuth').value+'°, высота солнца '+$('sunAltitude').value+'°':'');
}
['showElevation','showSlope','showAspect','showHillshade'].forEach((id,i)=>$(id).onclick=()=>render(['elevation','slope','aspect','hillshade'][i]));
['azimuth','sunAltitude','shadeContrast'].forEach(id=>$(id).addEventListener('input',()=>{
  $(id+'Value').textContent=$(id).value+(id==='shadeContrast'?'%':'°');
  if(currentMode==='hillshade')render('hillshade');
}));
$('downloadPng').onclick=()=>{
  const a=document.createElement('a');a.download=`geosurvey_${currentMode}.png`;a.href=canvas.toDataURL('image/png');a.click();
};
$('downloadStats').onclick=()=>{
  const rows=[['Показатель','Значение'],['EPSG',dem.epsg||'не определён'],['Минимальная высота',dem.min],['Максимальная высота',dem.max],['Средняя высота',dem.mean],['Перепад высот',dem.max-dem.min],['Ширина растра',dem.width],['Высота растра',dem.height],['Количество ячеек',dem.count],['Размер пикселя X (м или единицы)',dem.spacingX],['Размер пикселя Y (м или единицы)',dem.spacingY]];
  const csv='\uFEFF'+rows.map(r=>r.join(';')).join('\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.download='geosurvey_statistics.csv';a.click();URL.revokeObjectURL(a.href);
};

// Отдельный демонстрационный модуль распознавания объектов
$('objectFile').addEventListener('change',()=>{
  const file=$('objectFile').files?.[0];if(!file)return;
  const url=URL.createObjectURL(file);const img=new Image();
  img.onload=()=>{objectImage=img;const c=$('objectCanvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);$('detectObjects').disabled=false;$('objectStatus').textContent='Изображение загружено.';URL.revokeObjectURL(url);};
  img.onerror=()=>{$('objectStatus').textContent='Не удалось открыть изображение.';URL.revokeObjectURL(url);};
  img.src=url;
});
$('detectObjects').addEventListener('click',async()=>{
  if(!objectImage)return;
  const c=$('objectCanvas'),cctx=c.getContext('2d');
  try{
    $('detectObjects').disabled=true;$('objectStatus').textContent='Загружаю модель...';
    if(!objectModel)objectModel=await cocoSsd.load({base:'lite_mobilenet_v2'});
    $('objectStatus').textContent='Ищу объекты...';
    const found=await objectModel.detect(c,30,.35);
    cctx.drawImage(objectImage,0,0);
    found.forEach((d,i)=>{
      const [x,y,w,h]=d.bbox;cctx.strokeStyle='#ed2929';cctx.lineWidth=Math.max(2,c.width/500);cctx.strokeRect(x,y,w,h);
      cctx.fillStyle='#ed2929';cctx.font=`bold ${Math.max(14,c.width/70)}px Arial`;
      cctx.fillText(`${i+1}. ${d.class} ${(d.score*100).toFixed(0)}%`,x,Math.max(18,y-5));
    });
    $('objectResults').innerHTML=found.length?`<table><thead><tr><th>№</th><th>Объект</th><th>Уверенность</th></tr></thead><tbody>${found.map((d,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(d.class)}</td><td>${(d.score*100).toFixed(1)}%</td></tr>`).join('')}</tbody></table>`:'Объекты не найдены.';
    $('objectStatus').textContent=`Готово. Найдено объектов: ${found.length}.`;
  }catch(e){$('objectStatus').textContent='Ошибка: '+e.message;}
  finally{$('detectObjects').disabled=false;}
});
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
