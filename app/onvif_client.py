from __future__ import annotations
from typing import Optional, Any, Dict, List, Tuple
from dataclasses import dataclass

from onvif import ONVIFCamera


@dataclass
class OnvifDeviceSession:
    host: str
    port: int
    username: str
    password: str

    _cam: Optional[ONVIFCamera] = None

    def connect(self) -> ONVIFCamera:
        # ONVIFCamera loads WSDLs from the installed onvif package.
        self._cam = ONVIFCamera(self.host, self.port, self.username, self.password)
        return self._cam

    @property
    def cam(self) -> ONVIFCamera:
        if self._cam is None:
            return self.connect()
        return self._cam

    def get_device_information(self) -> Dict[str, Any]:
        dev_mgmt = self.cam.create_devicemgmt_service()
        return dev_mgmt.GetDeviceInformation()

    def get_profiles(self) -> List[Any]:
        media = self.cam.create_media_service()
        return media.GetProfiles()

    def get_rtsp_stream_uri(self, profile_token: Optional[str] = None) -> Tuple[str, str]:
        """
        Returns (rtsp_uri, profile_token_used)
        """
        media = self.cam.create_media_service()
        profiles = media.GetProfiles()
        if not profiles:
            raise RuntimeError("No media profiles found on device.")

        token = profile_token or profiles[0].token

        req = media.create_type("GetStreamUri")
        req.StreamSetup = {
            "Stream": "RTP-Unicast",
            "Transport": {"Protocol": "RTSP"},
        }
        req.ProfileToken = token

        uri_resp = media.GetStreamUri(req)
        rtsp_uri = uri_resp.Uri

        return rtsp_uri, token

    def create_pullpoint_subscription(self) -> Any:
        """
        Creates PullPoint subscription and returns the pullpoint service (or subscription object depending on device).
        """
        events = self.cam.create_events_service()

        # Some devices require a request object
        try:
            sub = events.CreatePullPointSubscription()
            return sub
        except Exception:
            req = events.create_type("CreatePullPointSubscription")
            req.InitialTerminationTime = "PT1H"
            req.SubscriptionPolicy = None
            sub = events.CreatePullPointSubscription(req)
            return sub

    def create_pullpoint_service_from_subscription(self, subscription: Any) -> Any:
        """
        subscription usually contains SubscriptionReference.Address.
        We create a PullPoint service bound to that address.
        """
        # The onvif lib can create a PullPoint service by passing xaddr.
        addr = None
        try:
            addr = subscription.SubscriptionReference.Address
        except Exception:
            # Some devices nest differently
            addr = getattr(subscription, "SubscriptionReference", None)
            if addr:
                addr = getattr(addr, "Address", None)

        if not addr:
            raise RuntimeError("Could not determine PullPoint endpoint address from subscription.")

        pullpoint = self.cam.create_pullpoint_service(addr)
        return pullpoint
