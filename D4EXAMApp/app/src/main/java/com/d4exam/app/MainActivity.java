package com.d4exam.app;

import android.annotation.SuppressLint;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Window;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.appcompat.app.AppCompatActivity;

/**
 * D4EXAM — Code Assist runnable app.
 * Same product UI as the website, inside an in-app WebView.
 */
public class MainActivity extends AppCompatActivity {

    public static final String APP_URL = "https://d4exam-platform.vercel.app";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#0b1b3a"));
        if (android.os.Build.VERSION.SDK_INT >= 21) {
            w.setNavigationBarColor(Color.parseColor("#0b1b3a"));
        }

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0b1b3a"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        if (android.os.Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false; // stay in-app
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    view.loadData(
                        "<html><body style='background:#0b1b3a;color:#fff;font-family:sans-serif;text-align:center;padding:40px'>"
                            + "<h2>D4EXAM</h2><p>No internet. Check network and try again.</p>"
                            + "<p><a style='color:#60a5fa' href='" + APP_URL + "'>Retry</a></p></body></html>",
                        "text/html",
                        "UTF-8"
                    );
                }
            }
        });

        web.loadUrl(APP_URL);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
