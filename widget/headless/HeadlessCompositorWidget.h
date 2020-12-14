/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef widget_headless_HeadlessCompositorWidget_h
#define widget_headless_HeadlessCompositorWidget_h

#include "mozilla/widget/CompositorWidget.h"

#include "HeadlessWidget.h"

namespace mozilla {
namespace widget {

class HeadlessCompositorWidgetInitData;

class HeadlessCompositorWidget final : public CompositorWidget,
                                       public CompositorWidgetDelegate {
 public:
  HeadlessCompositorWidget(const HeadlessCompositorWidgetInitData& aInitData,
                           const layers::CompositorOptions& aOptions,
                           HeadlessWidget* aWindow);

  void NotifyClientSizeChanged(const LayoutDeviceIntSize& aClientSize);
  void SetSnapshotListener(HeadlessWidget::SnapshotListener&& listener);

  // CompositorWidget Overrides

  already_AddRefed<gfx::DrawTarget> StartRemoteDrawingInRegion(
      LayoutDeviceIntRegion& aInvalidRegion, layers::BufferMode* aBufferMode) override;

  uintptr_t GetWidgetKey() override;

  LayoutDeviceIntSize GetClientSize() override;

  nsIWidget* RealWidget() override;
  CompositorWidgetDelegate* AsDelegate() override { return this; }

  void ObserveVsync(VsyncObserver* aObserver) override;

  // CompositorWidgetDelegate Overrides

  HeadlessCompositorWidget* AsHeadlessCompositorWidget() override {
    return this;
  }

 private:
  void SetSnapshotListenerOnCompositorThread(
      HeadlessWidget::SnapshotListener&& listener);
  void UpdateDrawTarget(const LayoutDeviceIntSize& aClientSize);
  void PeriodicSnapshot();
  void TakeSnapshot();

  HeadlessWidget* mWidget;

  LayoutDeviceIntSize mClientSize;

  HeadlessWidget::SnapshotListener mSnapshotListener;
  RefPtr<gfx::DrawTarget> mDrawTarget;
};

}  // namespace widget
}  // namespace mozilla

#endif  // widget_headless_HeadlessCompositor_h
