// IndexedDB helper functions
const DB_NAME = 'ExtensionData';
const DB_VERSION = 1;
const STORE_NAME = 'BackgroundImages';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = function (event) {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = function (event) {
      resolve(event.target.result);
    };

    request.onerror = function (event) {
      reject(event.target.error);
    };
  });
}

function getFromDatabase(key) {
  return openDatabase().then((db) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onsuccess = function (event) {
        resolve(event.target.result);
      };

      request.onerror = function (event) {
        reject(event.target.error);
      };
    });
  });
}

function saveToDatabase(key, value) {
  return openDatabase().then((db) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(value, key);

      request.onsuccess = function () {
        resolve();
      };

      request.onerror = function (event) {
        reject(event.target.error);
      };
    });
  });
}

function deleteFromDatabase(key) {
  return openDatabase().then((db) => {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(key);

      request.onsuccess = function () {
        resolve();
      };

      request.onerror = function (event) {
        reject(event.target.error);
      };
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const grid = document.getElementById('bookmark-grid');
  const headerTitle = document.getElementById('header-title');
  const backButton = document.getElementById('back-button');
  let folderStack = [];
  let rootFolderId;

  // References to modal elements
  const editBookmarkModal = document.getElementById('edit-bookmark-modal');
  const closeModalButton = document.getElementById('close-modal');
  const editBookmarkForm = document.getElementById('edit-bookmark-form');
  const bookmarkTitleInput = document.getElementById('bookmark-title');
  const bookmarkUrlInput = document.getElementById('bookmark-url');

  // References to the bookmark context menu
  const bookmarkContextMenu = document.getElementById('bookmark-context-menu');
  const editBookmarkOption = document.getElementById('edit-bookmark');

  let currentBookmarkId = null;
  let currentBackgroundUrl = null;

  // Function to determine if an image is dark
  function isImageDark(imageDataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.src = imageDataUrl;
      img.onload = () => {
        // Create a canvas to draw the image
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');

        // Draw the image onto the canvas
        ctx.drawImage(img, 0, 0, img.width, img.height);

        // Get image data
        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        const data = imageData.data;

        let colorSum = 0;

        // Iterate over all pixels and sum their brightness
        for (let x = 0, len = data.length; x < len; x += 4) {
          const r = data[x];
          const g = data[x + 1];
          const b = data[x + 2];

          // Calculate the luminance
          const brightness = (r * 299 + g * 587 + b * 114) / 1000;
          colorSum += brightness;
        }

        // Calculate the average brightness
        const averageBrightness = colorSum / (img.width * img.height);

        // Define a threshold to determine if the image is dark
        const threshold = 128; // You can adjust this value
        resolve(averageBrightness < threshold);
      };

      img.onerror = () => {
        // If there's an error loading the image, assume it's not dark
        resolve(false);
      };
    });
  }

  // Function to get the average color of an image
  function getAverageColor(imageDataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.src = imageDataUrl;
      img.onload = () => {
        // Create a canvas to draw the image
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');

        // Draw the image onto the canvas
        ctx.drawImage(img, 0, 0, img.width, img.height);

        // Get image data
        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        const data = imageData.data;

        let r = 0, g = 0, b = 0;
        const totalPixels = img.width * img.height;

        // Iterate over all pixels and sum their RGB values
        for (let i = 0; i < data.length; i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          // Ignore alpha (data[i + 3])
        }

        // Calculate average RGB values
        r = Math.round(r / totalPixels);
        g = Math.round(g / totalPixels);
        b = Math.round(b / totalPixels);

        resolve({ r, g, b });
      };

      img.onerror = (err) => {
        reject(err);
      };
    });
  }

  // Function to get the favicon Data URL or return null if not available
  async function getFaviconDataUrl(bookmark) {
    if (!bookmark.url) {
      return null;
    }

    const urlOrigin = new URL(bookmark.url).origin;

    // Check if favicon is in cache
    const cachedFavicon = await getCachedFavicon(urlOrigin);
    if (cachedFavicon) {
      return cachedFavicon;
    }

    // List of favicon URLs to try
    const faviconUrls = [
      `${urlOrigin}/apple-touch-icon.png`,
      `https://icon.horse/icon/${new URL(bookmark.url).hostname}`,
      `https://www.google.com/s2/favicons?domain=${new URL(bookmark.url).hostname}&sz=128`,
    ];

    for (const faviconUrl of faviconUrls) {
      try {
        const faviconDataUrl = await fetchFaviconAsDataUrl(faviconUrl);
        if (faviconDataUrl) {
          // Cache the favicon
          await cacheFavicon(urlOrigin, faviconDataUrl);
          return faviconDataUrl;
        }
      } catch (error) {
        // Continue to the next favicon URL
        console.error(`Failed to fetch favicon from ${faviconUrl}:`, error);
      }
    }

    return null;
  }

  // Function to fetch favicon and convert it to a Data URL
  async function fetchFaviconAsDataUrl(faviconUrl) {
    try {
      const response = await fetch(faviconUrl);
      if (!response.ok) {
        return null;
      }
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      return dataUrl;
    } catch (error) {
      return null;
    }
  }

  // Function to get cached favicon
  async function getCachedFavicon(origin) {
    try {
      const result = await browser.storage.local.get(origin);
      return result[origin] || null;
    } catch (error) {
      console.error('Error getting cached favicon:', error);
      return null;
    }
  }

  // Function to cache favicon
  async function cacheFavicon(origin, dataUrl) {
    try {
      await browser.storage.local.set({ [origin]: dataUrl });
    } catch (error) {
      console.error('Error caching favicon:', error);
    }
  }

  function createBookmarkElement(bookmark) {
    const item = document.createElement('div');
    item.className = 'bookmark-item';

    const imgContainer = document.createElement('div');
    imgContainer.className = 'bookmark-icon';

    const title = document.createElement('span');
    title.textContent = bookmark.title || bookmark.url;

    if (bookmark.type === 'folder') {
      const folderPreview = document.createElement('div');
      folderPreview.className = 'folder-preview';
      imgContainer.appendChild(folderPreview);

      // Fetch up to 9 children to display as folder preview
      browser.bookmarks.getChildren(bookmark.id).then((children) => {
        const previewItems = children.slice(0, 9);

        if (previewItems.length === 0) {
          // Optionally, display a default folder icon
        } else {
          previewItems.forEach((child) => {
            const gridItem = document.createElement('div');
            gridItem.className = 'folder-grid-item';

            getFaviconDataUrl(child).then((faviconDataUrl) => {
              if (faviconDataUrl) {
                const img = document.createElement('img');
                img.src = faviconDataUrl;
                img.onerror = () => {
                  const placeholder = createPlaceholderIcon(child.title);
                  gridItem.appendChild(placeholder);
                };
                gridItem.appendChild(img);
              } else {
                const placeholder = createPlaceholderIcon(child.title);
                gridItem.appendChild(placeholder);
              }

              // Append the gridItem to folderPreview after content is added
              folderPreview.appendChild(gridItem);
            });
          });
        }
      });

      item.addEventListener('click', () => {
        folderStack.push({ id: bookmark.parentId, name: headerTitle.textContent });
        loadBookmarks(bookmark.id, bookmark.title);
      });

      // Add context menu event listener to folders if needed
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        showBookmarkContextMenu(event, bookmark);
      });
    } else if (bookmark.url) {
      getFaviconDataUrl(bookmark).then((faviconDataUrl) => {
        if (faviconDataUrl) {
          const faviconImg = document.createElement('img');
          faviconImg.src = faviconDataUrl;
          faviconImg.onerror = () => {
            const placeholder = createPlaceholderIcon(bookmark.title);
            imgContainer.appendChild(placeholder);
          };
          imgContainer.appendChild(faviconImg);
        } else {
          const placeholder = createPlaceholderIcon(bookmark.title);
          imgContainer.appendChild(placeholder);
        }
      });

      item.addEventListener('click', () => {
        window.open(bookmark.url, '_blank');
      });

      // Add context menu event listener to bookmarks
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        showBookmarkContextMenu(event, bookmark);
      });
    }

    item.appendChild(imgContainer);
    item.appendChild(title);
    grid.appendChild(item);
  }

  // Function to create a placeholder icon
  function createPlaceholderIcon(title) {
    const placeholder = document.createElement('div');
    placeholder.className = 'placeholder-icon';
    placeholder.textContent = title ? title.charAt(0).toUpperCase() : '?';
    return placeholder;
  }

  function loadBookmarks(folderId, folderName = 'Favorites') {
    grid.innerHTML = '';
    headerTitle.textContent = folderName;

    if (folderStack.length > 0) {
      backButton.style.display = 'block';
    } else {
      backButton.style.display = 'none';
    }

    browser.bookmarks.getChildren(folderId).then((bookmarks) => {
      bookmarks.forEach(createBookmarkElement);
    });
  }

  backButton.addEventListener('click', () => {
    const previousFolder = folderStack.pop();
    if (previousFolder) {
      loadBookmarks(previousFolder.id, previousFolder.name);
    } else {
      // We're back at the root
      loadBookmarks(rootFolderId, 'Favorites');
    }
  });

  // Function to apply the background image from storage
  async function applyBackgroundImage() {
    try {
      const result = await browser.storage.local.get([
        'isBackgroundImageDark',
        'backgroundFit',
        'averageBackgroundColor',
      ]);
      const containerDiv = document.getElementById('container');

      // Retrieve the image Blob from IndexedDB
      const imageBlob = await getFromDatabase('backgroundImage');

      if (imageBlob) {
        // Revoke the previous Object URL if any
        if (currentBackgroundUrl) {
          URL.revokeObjectURL(currentBackgroundUrl);
        }

        // Create an Object URL from the Blob
        currentBackgroundUrl = URL.createObjectURL(imageBlob);

        containerDiv.style.backgroundImage = `url(${currentBackgroundUrl})`;

        // Apply background fit preference
        switch (result.backgroundFit) {
          case 'contain':
            containerDiv.style.backgroundSize = 'contain';
            break;
          case 'stretch':
            containerDiv.style.backgroundSize = '100% 100%';
            break;
          default:
            containerDiv.style.backgroundSize = 'cover';
        }

        // Apply the average background color
        if (result.averageBackgroundColor) {
          containerDiv.style.backgroundColor = result.averageBackgroundColor;
        } else {
          containerDiv.style.backgroundColor = ''; // Default background color
        }

        // Adjust font color based on brightness
        if (result.isBackgroundImageDark) {
          containerDiv.classList.add('dark-background');
        } else {
          containerDiv.classList.remove('dark-background');
        }
      } else {
        // Revoke the previous Object URL if any
        if (currentBackgroundUrl) {
          URL.revokeObjectURL(currentBackgroundUrl);
          currentBackgroundUrl = null;
        }

        // No background image set
        containerDiv.style.backgroundImage = ''; // Reset to default
        containerDiv.style.backgroundColor = ''; // Reset to default background color
        containerDiv.classList.remove('dark-background');
      }
    } catch (error) {
      console.error('Error applying background image:', error);
    }
  }

  // Function to handle context menu actions for empty space
  function handleContextMenu(event) {
    event.preventDefault();

    // Check if the click is not on a bookmark item
    if (!event.target.closest('.bookmark-item')) {
      // Hide bookmark context menu if open
      bookmarkContextMenu.style.display = 'none';

      // Show the custom context menu
      const contextMenu = document.getElementById('custom-context-menu');
      contextMenu.style.display = 'block';
      contextMenu.style.left = `${event.pageX}px`;
      contextMenu.style.top = `${event.pageY}px`;
    } else {
      // Hide the custom context menu if it's open
      document.getElementById('custom-context-menu').style.display = 'none';
    }
  }

  // Function to hide context menus
  function hideContextMenus() {
    document.getElementById('custom-context-menu').style.display = 'none';
    bookmarkContextMenu.style.display = 'none';
  }

  // Function to set the background image
  async function setBackgroundImage() {
    // Create an input element to select files
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';

    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (file) {
        // Store the image Blob in IndexedDB
        try {
          await saveToDatabase('backgroundImage', file);

          // Analyze image brightness
          const dataUrl = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(file);
          });

          const isDark = await isImageDark(dataUrl);

          // Get average color
          const averageColor = await getAverageColor(dataUrl);

          // Convert average color to CSS RGB string
          const averageColorCss = `rgb(${averageColor.r}, ${averageColor.g}, ${averageColor.b})`;

          // Store additional settings in browser.storage.local
          await browser.storage.local.set({
            isBackgroundImageDark: isDark,
            averageBackgroundColor: averageColorCss,
          });

          // Apply the background image and adjust font color
          applyBackgroundImage();
        } catch (error) {
          console.error('Error setting background image:', error);
        }
      }
    };

    // Trigger the file selection dialog
    input.click();
  }

  // Function to reset the background image
  async function resetBackgroundImage() {
    try {
      await deleteFromDatabase('backgroundImage');
      await browser.storage.local.remove([
        'isBackgroundImageDark',
        'backgroundFit',
        'averageBackgroundColor',
      ]);
      const containerDiv = document.getElementById('container');
      containerDiv.style.backgroundImage = '';
      containerDiv.style.backgroundColor = '';
      containerDiv.classList.remove('dark-background');

      // Revoke the Object URL if any
      if (currentBackgroundUrl) {
        URL.revokeObjectURL(currentBackgroundUrl);
        currentBackgroundUrl = null;
      }
    } catch (error) {
      console.error('Error resetting background image:', error);
    }
  }

  // Function to show the bookmark context menu
  function showBookmarkContextMenu(event, bookmark) {
    // Hide other context menus
    document.getElementById('custom-context-menu').style.display = 'none';

    // Show the bookmark context menu
    bookmarkContextMenu.style.display = 'block';
    bookmarkContextMenu.style.left = `${event.pageX}px`;
    bookmarkContextMenu.style.top = `${event.pageY}px`;

    // Set the current bookmark ID
    currentBookmarkId = bookmark.id;
  }

  // Event listener to hide context menus when clicking elsewhere
  document.addEventListener('click', hideContextMenus);

  // Event listener for the context menu on empty space
  document.addEventListener('contextmenu', handleContextMenu);

  // Event listeners for context menu actions
  document.getElementById('set-background-image').addEventListener('click', () => {
    hideContextMenus();
    setBackgroundImage();
  });

  document.getElementById('reset-background-image').addEventListener('click', () => {
    hideContextMenus();
    resetBackgroundImage();
  });

  // Event listeners for background fit options
  document.getElementById('background-fit-cover').addEventListener('click', () => {
    hideContextMenus();
    setBackgroundFit('cover');
  });

  document.getElementById('background-fit-contain').addEventListener('click', () => {
    hideContextMenus();
    setBackgroundFit('contain');
  });

  document.getElementById('background-fit-stretch').addEventListener('click', () => {
    hideContextMenus();
    setBackgroundFit('stretch');
  });

  // Function to set the background fit preference
  async function setBackgroundFit(fit) {
    try {
      await browser.storage.local.set({ backgroundFit: fit });
      applyBackgroundImage();
    } catch (error) {
      console.error('Error setting background fit:', error);
    }
  }

  // Function to open the edit bookmark modal
  function openEditBookmarkModal() {
    // Get the current bookmark details
    browser.bookmarks.get(currentBookmarkId).then((bookmarks) => {
      const bookmark = bookmarks[0];
      bookmarkTitleInput.value = bookmark.title;
      bookmarkUrlInput.value = bookmark.url || '';
      editBookmarkModal.style.display = 'flex';
    });
  }

  // Event listener for closing the modal
  closeModalButton.addEventListener('click', () => {
    editBookmarkModal.style.display = 'none';
  });

  // Event listener for submitting the edit form
  editBookmarkForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const updatedTitle = bookmarkTitleInput.value;
    const updatedUrl = bookmarkUrlInput.value;

    // Update the bookmark
    browser.bookmarks.update(currentBookmarkId, {
      title: updatedTitle,
      url: updatedUrl,
    }).then(() => {
      // Close the modal
      editBookmarkModal.style.display = 'none';

      // Reload the bookmarks
      const currentFolderId = folderStack.length > 0 ? folderStack[folderStack.length - 1].id : rootFolderId;
      const currentFolderName = folderStack.length > 0 ? folderStack[folderStack.length - 1].name : 'Favorites';
      loadBookmarks(currentFolderId, currentFolderName);
    }).catch((error) => {
      console.error('Error updating bookmark:', error);
      alert('An error occurred while updating the bookmark.');
    });
  });

  // Apply the background image on load
  applyBackgroundImage();

  // Start by loading the "Bookmarks Toolbar" folder
  browser.bookmarks.getTree().then((bookmarkTree) => {
    const toolbar = bookmarkTree[0].children.find(
      (node) => node.title === 'Bookmarks Toolbar'
    );
    if (toolbar) {
      rootFolderId = toolbar.id;
      loadBookmarks(toolbar.id, 'Favorites');
    } else {
      console.error('Bookmarks Toolbar not found.');
    }
  });
});