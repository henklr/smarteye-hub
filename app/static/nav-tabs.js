document.addEventListener("DOMContentLoaded", () => {
  const tabsContainers = document.querySelectorAll(".tabs");

  tabsContainers.forEach((tabs) => {
    const activeTab = tabs.querySelector(".tab.active");
    if (!activeTab) return;

    const centerActiveTab = () => {
      const containerWidth = tabs.clientWidth;
      const targetLeft =
        activeTab.offsetLeft - (containerWidth / 2) + (activeTab.offsetWidth / 2);

      const maxScrollLeft = tabs.scrollWidth - containerWidth;
      const clampedLeft = Math.max(0, Math.min(targetLeft, maxScrollLeft));

      tabs.scrollTo({
        left: clampedLeft,
        behavior: "auto"
      });
    };

    requestAnimationFrame(centerActiveTab);
    window.addEventListener("resize", centerActiveTab, { passive: true });
  });
});
