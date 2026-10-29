<script setup>
/**
 * 页面级浮层滚动条。
 *
 * 现代 Chromium 已移除 `overflow: overlay`（按 `auto` 处理，滚动条仍占 8px 宽），
 * 页面在有/无滚动条之间切换时内容宽度会跳变。这里把 body 原生滚动条隐藏（见 main.css），
 * 用这个固定定位的细条浮在页面上，滚动条出现与否都不再影响布局宽度。
 */
import { onMounted, onUnmounted, ref } from 'vue'

const EDGE_GAP = 4 // 轨道上下留白
const MIN_THUMB = 36 // 内容极长时滑块的最小高度
const IDLE_DELAY = 900 // 停止滚动后滑块淡出的延时

const visible = ref(false) // 页面当前是否可滚动
const active = ref(false) // 滚动期间临时显形
const thumbTop = ref(0)
const thumbHeight = ref(MIN_THUMB)
const dragging = ref(false)

// 内容高度只在尺寸 / 内容变化时重算，滚动时只按缓存的量级移动滑块
const metrics = {
  scrollable: false,
  scrollRange: 0,
  trackRange: 0,
  thumbHeight: MIN_THUMB,
}

let paintRaf = 0
let measureRaf = 0
let idleTimer = 0
let hovering = false
let resizeObserver = null
let mutationObserver = null
let dragStartY = 0
let dragStartScroll = 0

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const clearIdleTimer = () => {
  if (!idleTimer) return
  clearTimeout(idleTimer)
  idleTimer = 0
}

const scheduleHide = () => {
  clearIdleTimer()
  if (!visible.value || dragging.value || hovering) return
  idleTimer = setTimeout(() => {
    idleTimer = 0
    if (!dragging.value && !hovering) active.value = false
  }, IDLE_DELAY)
}

const reveal = () => {
  if (!visible.value) return
  active.value = true
  scheduleHide()
}

const paint = () => {
  paintRaf = 0
  if (!metrics.scrollable) return
  const progress = metrics.scrollRange > 0 ? window.scrollY / metrics.scrollRange : 0
  thumbTop.value = EDGE_GAP + Math.round(metrics.trackRange * clamp(progress, 0, 1))
}

const measure = () => {
  measureRaf = 0
  const viewportHeight = window.innerHeight
  const scrollHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight
  )
  // Dialog 打开时 TDesign 会把 body 锁成 overflow-y: hidden，此时不显示页面滚动条
  metrics.scrollable =
    scrollHeight > viewportHeight + 1 &&
    getComputedStyle(document.body).overflowY !== 'hidden'
  visible.value = metrics.scrollable
  if (!metrics.scrollable) {
    clearIdleTimer()
    active.value = false
    return
  }

  const trackHeight = viewportHeight - EDGE_GAP * 2
  const height = Math.min(
    trackHeight,
    Math.max(MIN_THUMB, Math.round((trackHeight * viewportHeight) / scrollHeight))
  )
  metrics.thumbHeight = height
  metrics.scrollRange = scrollHeight - viewportHeight
  metrics.trackRange = trackHeight - height
  thumbHeight.value = height
  paint()
}

const schedulePaint = () => {
  if (paintRaf) return
  paintRaf = requestAnimationFrame(paint)
}

const scheduleMeasure = () => {
  if (measureRaf) return
  measureRaf = requestAnimationFrame(measure)
}

const onPointerDown = (event) => {
  if (!visible.value) return
  reveal()
  dragging.value = true
  dragStartY = event.clientY
  dragStartScroll = window.scrollY
  event.currentTarget.setPointerCapture?.(event.pointerId)
  event.preventDefault()
}

const onPointerEnter = () => {
  hovering = true
  reveal()
}

const onPointerLeave = () => {
  hovering = false
  scheduleHide()
}

const onPointerMove = (event) => {
  if (!dragging.value || metrics.trackRange <= 0) return
  const delta = ((event.clientY - dragStartY) / metrics.trackRange) * metrics.scrollRange
  window.scrollTo(0, dragStartScroll + delta)
}

const onPointerUp = (event) => {
  if (!dragging.value) return
  dragging.value = false
  event.currentTarget.releasePointerCapture?.(event.pointerId)
  scheduleHide()
}

const onScroll = () => {
  reveal()
  schedulePaint()
}

onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', scheduleMeasure)
  if ('ResizeObserver' in window) {
    // body 高度随视图切换变化
    resizeObserver = new ResizeObserver(scheduleMeasure)
    resizeObserver.observe(document.body)
  }
  // TDesign Dialog 通过注入 <style> 锁定 body 滚动，不会触发 resize；监听后重算可见性
  mutationObserver = new MutationObserver(scheduleMeasure)
  mutationObserver.observe(document.head, { childList: true })
  mutationObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
  scheduleMeasure()
})

onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', scheduleMeasure)
  resizeObserver?.disconnect()
  mutationObserver?.disconnect()
  clearIdleTimer()
  resizeObserver = null
  mutationObserver = null
  if (paintRaf) cancelAnimationFrame(paintRaf)
  if (measureRaf) cancelAnimationFrame(measureRaf)
})
</script>

<template>
  <div v-show="visible" class="overlay-scrollbar" :class="{ 'is-active': active }" aria-hidden="true">
    <div
      class="overlay-scrollbar__thumb"
      :class="{ 'is-dragging': dragging }"
      :style="{ top: `${thumbTop}px`, height: `${thumbHeight}px` }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerenter="onPointerEnter"
      @pointerleave="onPointerLeave"
    />
  </div>
</template>

<style scoped>
.overlay-scrollbar {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 10px;
  /* 轨道不拦截点击：只有滑块本身可交互 */
  pointer-events: none;
  z-index: 999;
  /* 默认隐藏，滚动时淡入，停止后淡出 */
  opacity: 0;
  transition: opacity 0.25s ease;
}

.overlay-scrollbar.is-active {
  opacity: 1;
}

.overlay-scrollbar__thumb {
  position: absolute;
  right: 3px;
  width: 6px;
  border-radius: 3px;
  background-color: var(--td-scrollbar-color);
  pointer-events: none;
  transition: width 0.15s ease, right 0.15s ease, background-color 0.15s ease;
}

.overlay-scrollbar.is-active .overlay-scrollbar__thumb {
  pointer-events: auto;
}

.overlay-scrollbar__thumb:hover,
.overlay-scrollbar__thumb.is-dragging {
  right: 2px;
  width: 8px;
  background-color: var(--td-scrollbar-hover-color);
}
</style>
