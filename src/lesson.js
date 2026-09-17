export function createLesson({ THREE, groups, assembly, camera, controls }) {
  const parts = [];
  assembly.updateMatrixWorld(true);
  function part(title, hint, nodes) {
    const group = new THREE.Group();
    assembly.add(group);
    nodes.filter(Boolean).forEach(node => group.attach(node));
    const sprites = [];
    group.traverse(node => { if (node.isSprite) sprites.push(node); });
    sprites.forEach(node => node.removeFromParent());
    group.traverse(node => {
      if (node.isMesh) {
        node.material = node.material.clone();
        node.material.emissive?.setHex(0);
        node.material.transparent = false;
        node.material.opacity = 1;
      }
    });
    parts.push({ title, hint, group });
  }
  const pcb = groups.pcb.children[0];
  const headers = [...groups.headers.children[0].children].filter(n => !n.isSprite);
  const screen = [...groups.screen.children[0].children];
  const buttons = [...groups.controls.children[0].children];
  const screws = [...groups.fasteners.children[0].children];
  const cad = [];
  Object.values(groups).forEach(g => g.traverse(n => {
    if (n.isGroup && /^(上壳|底壳|按键1|摇把帽|摇把盖板|lens)/.test(n.name)) cad.push(n);
  }));
  const named = pattern => cad.filter(n => pattern.test(n.name));
  part('PCB 底板', '先认识绿色底板。按照片方向平放、丝印面朝上，三组按键孔朝前，右前侧是摇杆位；它是其他电子零件的安装基础。', [pcb]);
  part('第一条排母', '黑色 1×20P 长条，上面是插孔。按照片方向对齐底板第一排孔；实际还需在板背面焊接固定。', headers.filter(n => n.position.z < 0));
  part('第二条排母', '另一条 1×20P 排母装到对应的平行孔排。两条排母都焊好、检查无连锡后再插主控板。', headers.filter(n => n.position.z > 0));
  part('ESP32-P4 主控板', '元件面朝上，按照片方向 USB-C 在左、金属屏蔽无线模块在右；将板下方两排针同时对齐排母，从上方均匀压入。', [groups.esp32.children[0]]);
  part('2.8 英寸屏幕', '这一步只看屏幕本体。先支撑好屏幕，让后面的排线连接位置露出来。', screen.slice(0, 2));
  part('屏幕排线（22P 同向）', '本套接线只用照片中标着“22pin 同向排线”的这一根：一端插紫色屏幕板中间标“22”的 P2 座，另一端插 ESP32-P4 板标“DISPLAY”的座。不要插 CAMERA；两根 15pin 是其他主机接口的备选线。先断电，打开锁扣，金手指平直插到底后再扣回。', screen.slice(2, 4));
  part('黑色底壳', '单独认识底壳，再展示它与电子组件的相对位置；实际应将组件放入底壳，最终孔位仍需 PCB 文件校准。', named(/^底壳/));
  part('扬声器', '小喇叭放进壳内的预留区域，线材留出余量。这里先单独看清喇叭再放入。', buttons.slice(8, 10));
  part('扬声器连接线', '拿住插头连接对应的喇叭插座，不要拉扯导线；实物端子和极性需要核对。', buttons.slice(10, 11));
  part('白色上壳', '先整理排线，避开壳边和螺柱，再合上白色上壳。已装部分淡显，便于看清本件。', named(/^上壳/));
  const caps = named(/^按键1/);
  for (let i = 0; i < 3; i++) part('第 ' + (i + 1) + ' 个键帽', '将键帽对准已经安装并焊好的机械轴轴心，垂直压入。这一步装的是键帽。', caps[i] ? [caps[i]] : buttons.slice(i * 2, i * 2 + 2));
  part('摇杆盖板', '小盖板对准摇杆轴，检查活动空间。', named(/^摇把盖板/));
  part('摇杆帽', '将橙色摇杆帽对准轴端，装好后检查四向动作。', named(/^摇把帽/));
  part('屏幕外框', '对准屏幕周围边缘安装外框。不同玻璃屏版本的安装方式需按实物确认。', named(/^lens/));
  part('第一颗螺钉', '合壳并确认不夹线后，从背面锁第一颗 M2.5×6。热熔铜螺母需提前安装；螺钉位置暂为示意。', screws.slice(0, 2));
  part('第二颗螺钉', '锁第二颗，轻轻拧紧即可。最后检查按键、摇杆和屏幕排线。', screws.slice(2, 4));
  Object.values(groups).forEach(g => { g.visible = false; });
  let index = 0, elapsed = 0, moving = false, finished = false, continuous = false;
  let last = performance.now(), autoWait = 0;
  const duration = 3.5;
  const direction = new THREE.Vector3(0, 62, 0);
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0,-1,0), new THREE.Vector3(), 24, 0xffad79, 6, 3);
  assembly.add(arrow);
  const caption = document.createElement('div');
  caption.className = 'lesson-caption';
  document.querySelector('.stage-card').append(caption);
  const microGuide = document.createElement('section');
  microGuide.className = 'micro-guide';
  microGuide.setAttribute('aria-live', 'polite');
  const sideCard = document.querySelector('.side-card');
  const list = document.querySelector('#stepList');
  sideCard.insertBefore(microGuide, list);
  let guidePhase = '';
  function renderMicroGuide() {
    const visible = index === 5;
    microGuide.hidden = !visible;
    if (!visible) return;
    microGuide.innerHTML = `
      <div class="micro-guide-head"><strong>屏幕排线只接这一根</strong><span>先认接口，再插线</span></div>
      <div class="cable-route" aria-label="接线路径">
        <span class="route-port purple">紫色屏幕板<br><b>P2 / 22</b></span>
        <span class="route-arrow">→</span>
        <span class="route-cable"><i></i><b>22pin 同向</b></span>
        <span class="route-arrow">→</span>
        <span class="route-port green">ESP32 绿板<br><b>DISPLAY</b></span>
      </div>
      <ol class="micro-steps">
        <li><b>断电</b><span>拔掉 USB-C，手上不要带电操作。</span></li>
        <li><b>找锁扣</b><span>白色座长边上的黑色/深色小条就是锁扣；只向外滑起约 1–2 mm，不要拔下来。</span></li>
        <li><b>认线面</b><span>银色条纹是金手指，朝向座子里的金属触点；蓝色是补强片，留在座子外侧、让锁扣压住。</span></li>
        <li><b>平直插入</b><span>从座子的开口边沿整排触点直推，22 根要全部对齐；不是从左边或右边沿着长边塞。</span></li>
        <li><b>扣回锁扣</b><span>确认排线到底且没有歪，再把黑色小条压/滑回原位。</span></li>
      </ol>
      <div class="orientation-note"><span class="blue-face"><i></i>蓝色补强片：朝锁扣外侧</span><span class="contact-face"><i></i>银色金手指：朝座内触点</span></div>
      <div class="micro-phase" data-guide-phase></div>`;
    guidePhase = '';
    updateMicroGuide();
  }
  function updateMicroGuide() {
    if (index !== 5) return;
    const phase = finished
      ? '现在：已插到底并锁紧，线身保持平整，不要折成死弯。'
      : !moving
        ? '现在：先找到两个接口上的黑色锁扣。'
        : elapsed < 0.65
          ? '动作 1：打开锁扣。'
          : elapsed < 1.45
            ? '动作 2：银色金手指先进入插槽。'
            : elapsed < 2.55
              ? '动作 3：排线平直推到底。'
              : '动作 4：扣回锁扣。';
    if (phase !== guidePhase) {
      guidePhase = phase;
      const phaseNode = microGuide.querySelector('[data-guide-phase]');
      if (phaseNode) phaseNode.textContent = phase;
    }
  }
  const action = document.querySelector('#playStep');
  const replay = document.querySelector('#toggleExploded');
  replay.textContent = '↺ 重看本步';
  const auto = document.createElement('button');
  auto.className = 'tool-btn'; auto.textContent = '连续演示：关';
  document.querySelector('.stage-toolbar').insertBefore(auto, document.querySelector('.stage-tip'));
  auto.onclick = () => {
    continuous = !continuous;
    auto.textContent = '连续演示：' + (continuous ? '开' : '关');
    if (continuous && !finished) moving = true;
  };
  list.innerHTML = '';
  parts.forEach((p, i) => {
    const button = document.createElement('button');
    button.className = 'step-item';
    button.innerHTML = '<span class="step-no">' + String(i+1).padStart(2,'0') + '</span><span class="step-copy"><strong>' + p.title + '</strong><small>一次只安装这一件</small></span><span class="step-chevron">›</span>';
    button.onclick = () => select(i);
    list.append(button);
  });
  const slider = document.querySelector('#progress');
  slider.max = parts.length - 1;
  document.querySelector('.timecodes').innerHTML = '<span>逐件安装</span><span id="timecode">先看清，再放入</span><span>' + parts.length + ' 件</span>';
  function select(next) {
    index = Math.max(0, Math.min(parts.length - 1, next));
    elapsed = 0; autoWait = 0; finished = false; moving = continuous;
    parts.forEach((p, i) => {
      p.group.visible = i <= index;
      p.group.position.set(0,0,0);
      p.group.traverse(n => {
        if (!n.isMesh) return;
        n.material.transparent = i < index;
        n.material.opacity = i < index ? 0.18 : 1;
        n.material.depthWrite = i >= index;
        n.material.needsUpdate = true;
      });
    });
    direction.set(0,62,0);
    parts[index].group.position.copy(direction);
    const bounds = new THREE.Box3().setFromObject(parts[index].group);
    const center = bounds.getCenter(new THREE.Vector3());
    controls.target.copy(center).add(new THREE.Vector3(0,-20,0));
    camera.position.copy(controls.target).add(new THREE.Vector3(135,115,180));
    document.querySelector('#stepTitle').textContent = (index+1) + ' / ' + parts.length + ' · ' + parts[index].title;
    document.querySelector('#stepHint').textContent = parts[index].hint;
    document.querySelector('#timelineLabel').textContent = parts[index].title;
    document.querySelector('#timelineCount').textContent = String(index+1).padStart(2,'0');
    slider.value = index;
    [...list.children].forEach((el,i) => el.classList.toggle('active',i === index));
    list.scrollTop = list.children[index].offsetTop - list.children[0].offsetTop;
    document.querySelector('#prevStep').disabled = index === 0;
    document.querySelector('#nextStep').disabled = index === parts.length-1;
    renderMicroGuide();
    status();
  }
  function status() {
    action.textContent = finished ? '↺ 再放一次' : moving ? '❚❚ 暂停动作' : elapsed ? '▶ 继续放入' : '↓ 放入本件';
    document.querySelector('#stepBadge').textContent = finished ? '已放入' : moving ? '缓慢放入' : '认识零件';
    caption.innerHTML = '<small>本次只看这一件 · ' + (index+1) + '/' + parts.length + '</small><strong>' + parts[index].title + '</strong><span>' + (finished ? '已放入。看清后点击下一件 →' : moving ? '正在缓慢靠近安装位置…' : '点击「放入本件」观看动作；其余待装件已隐藏') + '</span>';
  }
  action.onclick = () => { if (finished) select(index); moving = !moving; status(); };
  replay.onclick = () => select(index);
  document.querySelector('#prevStep').onclick = () => select(index-1);
  document.querySelector('#nextStep').onclick = () => select(index+1);
  slider.oninput = e => select(Number(e.target.value));
  document.querySelector('#resetCamera').onclick = () => select(index);
  document.querySelector('.legend').innerHTML = '<span>实色：当前零件</span><span>淡显：已经装好</span>';
  document.querySelector('.status').textContent = '逐件教学 · 点击放入 · 手动下一步';
  select(0);
  function update() {
    const now = performance.now(), dt = Math.min((now-last)/1000,0.1); last = now;
    if (moving && !finished) {
      elapsed = Math.min(duration, elapsed+dt);
      const t = elapsed/duration, eased = t*t*(3-2*t);
      parts[index].group.position.copy(direction).multiplyScalar(1-eased);
      if (elapsed >= duration) { finished = true; moving = false; status(); }
      else if (action.textContent !== '❚❚ 暂停动作') status();
    }
    updateMicroGuide();
    arrow.visible = !finished;
    if (arrow.visible) {
      const b = new THREE.Box3().setFromObject(parts[index].group);
      const center = assembly.worldToLocal(b.getCenter(new THREE.Vector3()));
      arrow.position.copy(center).add(new THREE.Vector3(b.getSize(new THREE.Vector3()).x/2+8,0,0));
      arrow.setDirection(direction.clone().normalize().negate());
    }
    if (continuous && finished) {
      autoWait += dt;
      if (autoWait > 2) {
        if (index < parts.length-1) select(index+1);
        else { continuous = false; auto.textContent = '连续演示：关'; }
      }
    }
  }
  return {update};
}
