/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/layers/CompositorThread.h"
#include "mozilla/widget/PlatformWidgetTypes.h"
#include "HeadlessCompositorWidget.h"
#include "VsyncDispatcher.h"

namespace mozilla {
namespace widget {

HeadlessCompositorWidget::HeadlessCompositorWidget(
    const HeadlessCompositorWidgetInitData& aInitData,
    const layers::CompositorOptions& aOptions, HeadlessWidget* aWindow)
    : CompositorWidget(aOptions), mWidget(aWindow) {
  mClientSize = aInitData.InitialClientSize();
}

void HeadlessCompositorWidget::SetSnapshotListener(HeadlessWidget::SnapshotListener&& listener) {
  MOZ_ASSERT(NS_IsMainThread());

  layers::CompositorThread()->Dispatch(NewRunnableMethod<HeadlessWidget::SnapshotListener&&>(
      "HeadlessCompositorWidget::SetSnapshotListener", this,
      &HeadlessCompositorWidget::SetSnapshotListenerOnCompositorThread,
      std::move(listener)));
}

void HeadlessCompositorWidget::SetSnapshotListenerOnCompositorThread(
    HeadlessWidget::SnapshotListener&& listener) {
  MOZ_ASSERT(NS_IsInCompositorThread());
  mSnapshotListener = std::move(listener);
  PeriodicSnapshot();
}

already_AddRefed<gfx::DrawTarget> HeadlessCompositorWidget::StartRemoteDrawingInRegion(
    LayoutDeviceIntRegion& aInvalidRegion, layers::BufferMode* aBufferMode) {
  if (!mDrawTarget)
    return nullptr;

  *aBufferMode = layers::BufferMode::BUFFER_NONE;
  RefPtr<gfx::DrawTarget> result = mDrawTarget;
  return result.forget();
}

void HeadlessCompositorWidget::ObserveVsync(VsyncObserver* aObserver) {
  if (RefPtr<CompositorVsyncDispatcher> cvd =
          mWidget->GetCompositorVsyncDispatcher()) {
    cvd->SetCompositorVsyncObserver(aObserver);
  }
}

nsIWidget* HeadlessCompositorWidget::RealWidget() { return mWidget; }

void HeadlessCompositorWidget::NotifyClientSizeChanged(
    const LayoutDeviceIntSize& aClientSize) {
  mClientSize = aClientSize;
  layers::CompositorThread()->Dispatch(NewRunnableMethod<LayoutDeviceIntSize>(
      "HeadlessCompositorWidget::UpdateDrawTarget", this,
      &HeadlessCompositorWidget::UpdateDrawTarget,
      aClientSize));
}

void HeadlessCompositorWidget::UpdateDrawTarget(const LayoutDeviceIntSize& aClientSize) {
  MOZ_ASSERT(NS_IsInCompositorThread());
  if (aClientSize.IsEmpty()) {
    mDrawTarget = nullptr;
    return;
  }

  RefPtr<gfx::DrawTarget> old = std::move(mDrawTarget);
  gfx::SurfaceFormat format = gfx::SurfaceFormat::B8G8R8A8;
  gfx::IntSize size = aClientSize.ToUnknownSize();
  mDrawTarget = mozilla::gfx::Factory::CreateDrawTarget(
      mozilla::gfx::BackendType::SKIA, size, format);
  if (old) {
    RefPtr<gfx::SourceSurface> snapshot = old->Snapshot();
    if (snapshot)
      mDrawTarget->CopySurface(snapshot.get(), old->GetRect(), gfx::IntPoint(0, 0));
  }
}

void HeadlessCompositorWidget::PeriodicSnapshot() {
  if (!mSnapshotListener)
    return;

  TakeSnapshot();
  NS_DelayedDispatchToCurrentThread(NewRunnableMethod(
      "HeadlessCompositorWidget::PeriodicSnapshot", this,
      &HeadlessCompositorWidget::PeriodicSnapshot), 40);
}

void HeadlessCompositorWidget::TakeSnapshot() {
  if (!mDrawTarget)
    return;

  RefPtr<gfx::SourceSurface> snapshot = mDrawTarget->Snapshot();
  if (!snapshot) {
    fprintf(stderr, "Failed to get snapshot of draw target\n");
    return;
  }

  RefPtr<gfx::DataSourceSurface> dataSurface = snapshot->GetDataSurface();
  if (!dataSurface) {
    fprintf(stderr, "Failed to get data surface from snapshot\n");
    return;
  }

  mSnapshotListener(std::move(dataSurface));
}

LayoutDeviceIntSize HeadlessCompositorWidget::GetClientSize() {
  return mClientSize;
}

uintptr_t HeadlessCompositorWidget::GetWidgetKey() {
  return reinterpret_cast<uintptr_t>(mWidget);
}

}  // namespace widget
}  // namespace mozilla
