import { Bell } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { api } from "../../../convex/_generated/api";
import { cn } from "../../utils/cn";

export function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const unreadNotifications = useQuery(api.notifications.query.listUnread);
  const markAsRead = useMutation(api.notifications.mutation.markAsRead);
  const markAllAsRead = useMutation(api.notifications.mutation.markAllAsRead);

  const unreadCount = unreadNotifications?.length ?? 0;

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleNotificationClick = async (
    notification: NonNullable<typeof unreadNotifications>[0],
  ) => {
    // Mark as read
    await markAsRead({ notificationId: notification._id });

    // Navigate based on notification type
    if (notification.type === "invitation_received") {
      navigate("/invitations");
    }

    setIsOpen(false);
  };

  const handleMarkAllAsRead = async () => {
    await markAllAsRead({});
  };

  return (
    <div className={cn("relative")} ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "relative p-2",
          "hover:bg-gray-100 dark:hover:bg-gray-800",
          "transition-colors",
        )}
        aria-label={t("notifications.title")}
        aria-expanded={isOpen}
      >
        <Bell size={20} />
        {unreadCount > 0 && (
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5",
              "min-w-[18px] h-[18px] px-1",
              "flex items-center justify-center",
              "text-xs font-bold text-white",
              "bg-red-500",
            )}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          className={cn(
            "absolute right-0 top-full mt-2",
            "w-80 max-w-[calc(100vw-2rem)]",
            "bg-white dark:bg-gray-900",
            "border border-gray-200 dark:border-gray-800",
            "shadow-lg",
            "z-50",
          )}
        >
          {/* Header */}
          <div
            className={cn(
              "flex items-center justify-between",
              "px-4 py-3",
              "border-b border-gray-200 dark:border-gray-800",
            )}
          >
            <h3 className={cn("font-bold text-sm")}>
              {t("notifications.title")}
            </h3>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllAsRead}
                className={cn(
                  "text-xs text-gray-500 hover:text-black",
                  "dark:text-gray-400 dark:hover:text-white",
                )}
              >
                {t("notifications.markAllRead")}
              </button>
            )}
          </div>

          {/* Notifications list */}
          <div className={cn("max-h-80 overflow-y-auto")}>
            {unreadNotifications && unreadNotifications.length > 0 ? (
              unreadNotifications.map((notification) => (
                <button
                  key={notification._id}
                  onClick={() => handleNotificationClick(notification)}
                  className={cn(
                    "w-full px-4 py-3 text-left",
                    "hover:bg-gray-50 dark:hover:bg-gray-800",
                    "border-b border-gray-100 dark:border-gray-800 last:border-b-0",
                    "transition-colors",
                  )}
                >
                  <p className={cn("text-sm font-medium mb-1")}>
                    {notification.title}
                  </p>
                  <p
                    className={cn(
                      "text-xs text-gray-500 dark:text-gray-400",
                      "line-clamp-2",
                    )}
                  >
                    {notification.message}
                  </p>
                </button>
              ))
            ) : (
              <div className={cn("px-4 py-8 text-center")}>
                <p className={cn("text-sm text-gray-500 dark:text-gray-400")}>
                  {t("notifications.noNotifications")}
                </p>
              </div>
            )}
          </div>

          {/* View all link */}
          {unreadCount > 0 && (
            <div
              className={cn(
                "px-4 py-3",
                "border-t border-gray-200 dark:border-gray-800",
              )}
            >
              <button
                onClick={() => {
                  navigate("/invitations");
                  setIsOpen(false);
                }}
                className={cn(
                  "text-sm text-center w-full",
                  "text-gray-600 hover:text-black",
                  "dark:text-gray-400 dark:hover:text-white",
                )}
              >
                {t("invitations.title")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
